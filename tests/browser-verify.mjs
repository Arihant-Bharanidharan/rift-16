import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ARTIFACTS = path.join(ROOT, 'artifacts');
const DOWNLOAD_ARTIFACTS = path.join(ARTIFACTS, 'downloads');
const REPORT_PATH = path.join(ARTIFACTS, 'browser-results.json');
const PAGE_URL = process.env.RIFT16_URL || 'http://127.0.0.1:4173/';
const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const KEEP_OPEN = process.argv.includes('--keep-open');
const TEMP_ROOT = process.env.RIFT16_TEMP_DIR || (existsSync('D:/TEMP/opencode') ? 'D:/TEMP/opencode' : tmpdir());
const EXPECTED = JSON.parse(readFileSync(path.join(ARTIFACTS, 'parity-results.json'), 'utf8'));
const EXPECTED_FILENAME = 'Untitled-signal-4bars-48000Hz.wav';

mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(DOWNLOAD_ARTIFACTS, { recursive: true });
mkdirSync(TEMP_ROOT, { recursive: true });

const report = {
  pass: false,
  timestamp: new Date().toISOString(),
  methodology: 'Dependency-free Node 22 CDP automation against an isolated Chrome profile. DOM input events and native mouse/keyboard input drive the production controller; the production Worker creates the WAV and Chrome downloads the actual file.',
  pageUrl: PAGE_URL,
  keepOpen: KEEP_OPEN,
  checks: {},
  screenshots: {},
  consoleErrors: [],
  failedRequests: [],
  httpErrors: []
};

let chrome;
let ws;
let nextId = 0;
const pending = new Map();
const eventWaiters = new Map();
const downloadEvents = [];
let downloadDirectory = '';
let browserClosed = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function saveReport() {
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

function record(name, value) {
  report.checks[name] = value;
  console.log(`PASS ${name}`);
}

function launchChrome() {
  const profile = mkdtempSync(path.join(TEMP_ROOT, 'rift16-chrome-profile-'));
  downloadDirectory = mkdtempSync(path.join(TEMP_ROOT, 'rift16-downloads-'));
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-sync',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,960',
    'about:blank'
  ];
  if (!KEEP_OPEN) args.unshift('--headless=new');

  chrome = spawn(CHROME_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  report.browserProfileIsolated = true;
  report.browserMode = KEEP_OPEN ? 'headful' : 'headless';

  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose CDP.\n${stderr}`)), 20000);
    chrome.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    chrome.once('exit', code => {
      if (!browserClosed) {
        clearTimeout(timer);
        reject(new Error(`Chrome exited before CDP was ready (${code}).\n${stderr}`));
      }
    });
    chrome.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/[^\s]+/);
      if (!match) return;
      clearTimeout(timer);
      const browserWebSocket = match[0].replace('DevTools listening on ', '');
      resolve({ browserWebSocket, profile });
    });
  });
}

function connect(webSocketUrl) {
  ws = new WebSocket(webSocketUrl);
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(`${item.method}: ${message.error.message}`));
      else item.resolve(message.result);
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      report.consoleErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      report.consoleErrors.push(message.params.args.map(arg => arg.value || arg.description || '').join(' '));
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      report.consoleErrors.push(message.params.entry.text);
    } else if (message.method === 'Network.loadingFailed' && !message.params.canceled) {
      report.failedRequests.push({ error: message.params.errorText, type: message.params.type });
    } else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      report.httpErrors.push({ status: message.params.response.status, url: message.params.response.url });
    } else if (message.method === 'Browser.downloadWillBegin' || message.method === 'Browser.downloadProgress') {
      downloadEvents.push({ method: message.method, ...message.params });
    }

    const waiters = eventWaiters.get(message.method);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message.params)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      if (!waiters.size) eventWaiters.delete(message.method);
      waiter.resolve(message.params);
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function send(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function waitEvent(method, predicate = () => true, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const waiters = eventWaiters.get(method) || new Set();
    const waiter = { resolve, predicate, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`${method} event timed out.`));
    }, timeoutMs);
    waiters.add(waiter);
    eventWaiters.set(method, waiters);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return;
    await delay(80);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function navigate(reload = false) {
  const loaded = waitEvent('Page.loadEventFired');
  if (reload) await send('Page.reload', { ignoreCache: true });
  else {
    const result = await send('Page.navigate', { url: PAGE_URL });
    if (result.errorText) throw new Error(result.errorText);
  }
  await loaded;
  await waitFor("document.querySelectorAll('#track-list .track-row').length === 4 && document.querySelectorAll('#keyboard .key-button').length === 13");
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
}

async function click(selector) {
  const escaped = JSON.stringify(selector);
  const found = await evaluate(`(() => {
    const element = document.querySelector(${escaped});
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return true;
  })()`);
  assert.equal(found, true, `Missing clickable element: ${selector}`);
  await delay(60);
  const point = await evaluate(`(() => {
    const rect = document.querySelector(${escaped}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  assert.ok(point.width > 0 && point.height > 0, `Element is not visible: ${selector}`);
  if (selector === '[data-action="select"][data-track="3"]') {
    console.log('Noise click target', await evaluate(`(() => {
      const element = document.querySelector(${escaped});
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(${point.x}, ${point.y});
      return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, point: { x: ${point.x}, y: ${point.y} }, hit: hit?.outerHTML, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, activeElement: document.activeElement?.outerHTML };
    })()`));
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(40);
}

async function key(key, code, modifiers = 0) {
  const virtualKeys = { Tab: 9, a: 65 };
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, modifiers,
    windowsVirtualKeyCode: virtualKeys[key] || key.charCodeAt(0)
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, modifiers,
    windowsVirtualKeyCode: virtualKeys[key] || key.charCodeAt(0)
  });
}

async function fill(selector, value, tabOut = false) {
  await click(selector);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: value });
  if (tabOut) await key('Tab', 'Tab');
}

async function setRange(selector, value) {
  const changed = await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    input.focus();
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  assert.equal(Number(changed), Number(value), `Range did not accept ${value}: ${selector}`);
}

async function selectOption(selector, value) {
  const changed = await evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    select.value = ${JSON.stringify(String(value))};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  assert.equal(changed, String(value));
}

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function inspectWav(bytes) {
  assert.ok(bytes.length >= 44);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  let offset = 12;
  let format;
  let dataSize = -1;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= bytes.length, `Truncated ${id} chunk`);
    if (id === 'fmt ') {
      assert.ok(size >= 16);
      format = {
        audioFormat: bytes.readUInt16LE(offset + 8),
        channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12),
        byteRate: bytes.readUInt32LE(offset + 16),
        blockAlign: bytes.readUInt16LE(offset + 20),
        bitsPerSample: bytes.readUInt16LE(offset + 22)
      };
    } else if (id === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  assert.ok(format, 'Missing fmt chunk');
  assert.ok(dataSize >= 0, 'Missing data chunk');
  assert.deepEqual(format, {
    audioFormat: 1,
    channels: 2,
    sampleRate: 48000,
    byteRate: 192000,
    blockAlign: 4,
    bitsPerSample: 16
  });
  assert.equal(dataSize, EXPECTED.frames * 4);
  return {
    riff: 'RIFF', wave: 'WAVE', riffSize: bytes.readUInt32LE(4),
    format, frames: dataSize / 4, dataBytes: dataSize
  };
}

async function metrics(width, height = 900, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
    screenWidth: width, screenHeight: height
  });
  await delay(100);
}

async function screenshot(name) {
  const layout = await send('Page.getLayoutMetrics');
  const height = Math.ceil(layout.cssContentSize.height);
  const width = Math.ceil(layout.cssContentSize.width);
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 }
  }, 30000);
  const file = path.join(ARTIFACTS, `${name}.png`);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  report.screenshots[name] = path.relative(ROOT, file);
}

async function verifyLayout(width) {
  await metrics(width, 900, true);
  await evaluate("window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('.pattern-scroll').scrollLeft = 0; true");
  await delay(120);
  const result = await evaluate(`(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const box = element => {
      const r = element.getBoundingClientRect();
      return { id: element.id || element.className, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const transport = document.querySelector('.transport');
    const transportRect = transport.getBoundingClientRect();
    const children = [...transport.children].filter(visible).map(box);
    const collisions = [];
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) collisions.push({ a: a.id, b: b.id, overlapX, overlapY });
      }
    }
    const clipped = children.filter(rect => rect.left < transportRect.left - 1 || rect.right > transportRect.right + 1 || rect.top < transportRect.top - 1 || rect.bottom > transportRect.bottom + 1);
    const pattern = document.querySelector('.pattern-scroll');
    return {
      requestedWidth: ${width},
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      transportCollisions: collisions,
      clippedTransportChildren: clipped,
      transportChildren: children,
      sequencer: { clientWidth: pattern.clientWidth, scrollWidth: pattern.scrollWidth, intentionallyScrollable: pattern.scrollWidth > pattern.clientWidth },
      media: { max480: matchMedia('(max-width: 480px)').matches, max680: matchMedia('(max-width: 680px)').matches }
    };
  })()`);
  if (width === 320 || width === 480) await screenshot(`layout-${width}`);
  assert.equal(result.viewport.width, width);
  assert.equal(result.pageOverflow, false, `${width}px page overflow`);
  assert.ok(result.bodyWidth <= width, `${width}px body overflow`);
  assert.deepEqual(result.transportCollisions, [], `${width}px transport collisions`);
  assert.deepEqual(result.clippedTransportChildren, [], `${width}px clipped transport children`);
  assert.equal(result.sequencer.intentionallyScrollable, true);
  assert.equal(result.media.max480, width <= 480);
  assert.equal(result.media.max680, true);
  record(`layout${width}`, result);
}

async function closeBrowser() {
  if (!ws || ws.readyState !== WebSocket.OPEN || browserClosed) return;
  browserClosed = true;
  try {
    await send('Browser.close', {}, 5000);
  } catch {}
}

try {
  assert.equal(EXPECTED.pass, true, 'Parity baseline must be passing');
  const { browserWebSocket } = await launchChrome();
  const endpoint = new URL(browserWebSocket);
  const listUrl = `http://${endpoint.host}/json/list`;
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    const targets = await (await fetch(listUrl)).json();
    target = targets.find(item => item.type === 'page');
    if (target) break;
    await delay(50);
  }
  assert.ok(target, 'No Chrome page target');
  await connect(target.webSocketDebuggerUrl);
  report.browser = await send('Browser.getVersion');

  await send('Page.enable');
  await send('Page.bringToFront');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true
  });
  await metrics(1280, 900, false);
  await navigate();
  await evaluate("localStorage.removeItem('rift16.project.v1'); true");
  await navigate(true);
  await waitFor("document.getElementById('project-name').value === 'Untitled signal'");

  await fill('#project-name', 'Verification / Signal 01');
  await fill('#tempo', '137', true);
  await click('[data-action="select"][data-track="3"]');
  try {
    await waitFor("document.getElementById('keyboard-target').textContent === 'Noise · F♯5'");
  } catch (error) {
    console.error('Noise click result', await evaluate(`(() => ({ target: document.getElementById('keyboard-target').textContent, project: document.getElementById('project-name').value, tempo: document.getElementById('tempo').value, activeElement: document.activeElement?.outerHTML }))()`));
    await screenshot('failure-noise-selection');
    throw error;
  }
  const noiseLabels = await evaluate(`(() => ({
    target: document.getElementById('keyboard-target').textContent,
    firstKey: document.querySelector('#keyboard [data-offset="0"]').getAttribute('aria-label'),
    lastKey: document.querySelector('#keyboard [data-offset="12"]').getAttribute('aria-label'),
    allKeysNameNoise: [...document.querySelectorAll('#keyboard .key-button')].every(key => key.getAttribute('aria-label').startsWith('Audition Noise,')),
    voiceLabels: [...document.querySelectorAll('#voice-params label')].map(label => label.textContent),
    channelLabels: [...document.querySelectorAll('#channel-params label')].map(label => label.textContent)
  }))()`);
  assert.equal(noiseLabels.target, 'Noise · F♯5');
  assert.equal(noiseLabels.firstKey, 'Audition Noise, F♯5, key A');
  assert.equal(noiseLabels.lastKey, 'Audition Noise, F♯6, key K');
  assert.equal(noiseLabels.allKeysNameNoise, true);
  assert.deepEqual(noiseLabels.voiceLabels, ['Noise cutoff', 'Decay', 'Metallic tone', 'Drive']);
  assert.deepEqual(noiseLabels.channelLabels, ['Level', 'Pan', 'Delay send']);

  await setRange('#parameter-noise-cutoff', 7300);
  await setRange('#parameter-noise-level', 0.51);
  await setRange('#parameter-noise-pan', -0.37);
  await click('.step-pad[data-track="3"][data-step="0"]');
  await click('#tab-step');
  await setRange('#step-note', 7);
  await setRange('#step-velocity', 0.61);
  await waitFor("document.getElementById('save-state').textContent === 'Saved locally'");

  const edited = await evaluate(`(() => {
    const state = JSON.parse(localStorage.getItem('rift16.project.v1'));
    return {
      name: state.name,
      bpm: state.bpm,
      delayDetail: document.getElementById('delay-time-detail').textContent,
      cutoff: state.tracks[3].params.cutoff,
      level: state.tracks[3].level,
      pan: state.tracks[3].pan,
      step: state.tracks[3].steps[0],
      stepTitle: document.getElementById('step-edit-title').textContent,
      stepDetail: document.getElementById('step-note-detail').textContent,
      padLabel: document.querySelector('.step-pad[data-track="3"][data-step="0"]').getAttribute('aria-label'),
      activeSummary: document.getElementById('pattern-summary').textContent
    };
  })()`);
  assert.equal(edited.name, 'Verification / Signal 01');
  assert.equal(edited.bpm, 137);
  assert.equal(edited.delayDetail, '328 ms at 137 BPM');
  assert.equal(edited.cutoff, 7300);
  assert.equal(edited.level, 0.51);
  assert.equal(edited.pan, -0.37);
  assert.deepEqual(edited.step, { active: true, velocity: 0.61, note: 7 });
  assert.equal(edited.stepTitle, 'Step 01');
  assert.equal(edited.stepDetail, 'C♯6 · 1108.73 Hz fundamental');
  assert.match(edited.padLabel, /^Noise step 1, enabled, velocity 61 percent, pitch \+7 semitones$/);
  assert.equal(edited.activeSummary, '29 / 64 active');
  record('editingAndNoiseLabels', { ...edited, ...noiseLabels });

  await navigate(true);
  await click('[data-action="select"][data-track="3"]');
  await click('#tab-step');
  const persisted = await evaluate(`(() => {
    const state = JSON.parse(localStorage.getItem('rift16.project.v1'));
    return {
      project: document.getElementById('project-name').value,
      tempo: document.getElementById('tempo').value,
      cutoff: document.getElementById('parameter-noise-cutoff').value,
      level: document.getElementById('parameter-noise-level').value,
      pan: document.getElementById('parameter-noise-pan').value,
      step: state.tracks[3].steps[0],
      stepNote: document.getElementById('step-note').value,
      stepVelocity: document.getElementById('step-velocity').value,
      stepEnabled: document.getElementById('step-enabled').checked,
      stepDetail: document.getElementById('step-note-detail').textContent,
      keyboardTarget: document.getElementById('keyboard-target').textContent
    };
  })()`);
  assert.equal(persisted.project, 'Verification / Signal 01');
  assert.equal(persisted.tempo, '137');
  assert.equal(persisted.cutoff, '7300');
  assert.equal(persisted.level, '0.51');
  assert.equal(persisted.pan, '-0.37');
  assert.deepEqual(persisted.step, { active: true, velocity: 0.61, note: 7 });
  assert.equal(persisted.stepNote, '7');
  assert.equal(persisted.stepVelocity, '0.61');
  assert.equal(persisted.stepEnabled, true);
  assert.equal(persisted.stepDetail, 'C♯6 · 1108.73 Hz fundamental');
  assert.equal(persisted.keyboardTarget, 'Noise · F♯5');
  record('reloadPersistence', persisted);

  await click('#new-project');
  assert.equal(await evaluate("document.getElementById('new-dialog').open"), true);
  await click('#cancel-new');
  assert.equal(await evaluate("document.getElementById('project-name').value"), 'Verification / Signal 01');
  await click('#new-project');
  await click('#confirm-new');
  await waitFor("document.getElementById('save-state').textContent === 'Saved locally'");
  const reset = await evaluate(`(() => ({
    state: JSON.parse(localStorage.getItem('rift16.project.v1')),
    project: document.getElementById('project-name').value,
    tempo: document.getElementById('tempo').value,
    inspector: document.getElementById('inspector-track').textContent,
    selectedPad: document.querySelector('.step-pad.selected').getAttribute('aria-label'),
    voiceTab: document.getElementById('tab-voice').getAttribute('aria-selected'),
    dialogOpen: document.getElementById('new-dialog').open,
    transport: document.getElementById('transport-state').textContent,
    position: document.getElementById('position-value').textContent,
    summary: document.getElementById('pattern-summary').textContent
  }))()`);
  assert.deepEqual(reset.state, EXPECTED.state);
  assert.equal(reset.project, 'Untitled signal');
  assert.equal(reset.tempo, '124');
  assert.equal(reset.inspector, 'Kick');
  assert.match(reset.selectedPad, /^Kick step 1,/);
  assert.equal(reset.voiceTab, 'true');
  assert.equal(reset.dialogOpen, false);
  assert.equal(reset.transport, 'Stopped');
  assert.equal(reset.position, '1.1');
  assert.equal(reset.summary, '28 / 64 active');
  record('newProjectReset', { ...reset, state: 'Exact match to parity default state' });

  await click('#open-export');
  await selectOption('#export-bars', 16);
  await selectOption('#export-sample-rate', 48000);
  await click('#render-wav');
  await waitFor("!document.getElementById('render-progress').hidden && document.getElementById('export-progress').value > 0", 30000);
  await click('#cancel-render');
  await waitFor("document.getElementById('render-progress').hidden && !document.getElementById('render-wav').disabled");
  await delay(500);
  const cancelled = await evaluate(`(() => ({
    dialogOpen: document.getElementById('export-dialog').open,
    progressHidden: document.getElementById('render-progress').hidden,
    resultHidden: document.getElementById('render-result').hidden,
    downloadHidden: document.getElementById('download-wav').hidden,
    downloadHref: document.getElementById('download-wav').getAttribute('href'),
    cancelHidden: document.getElementById('cancel-render').hidden,
    renderEnabled: !document.getElementById('render-wav').disabled,
    optionsEnabled: !document.getElementById('export-bars').disabled && !document.getElementById('export-sample-rate').disabled,
    errorHidden: document.getElementById('export-error').hidden,
    toast: document.getElementById('toast').textContent
  }))()`);
  assert.equal(cancelled.dialogOpen, true);
  assert.equal(cancelled.progressHidden, true);
  assert.equal(cancelled.resultHidden, true);
  assert.equal(cancelled.downloadHidden, true);
  assert.equal(cancelled.downloadHref, null);
  assert.equal(cancelled.cancelHidden, true);
  assert.equal(cancelled.renderEnabled, true);
  assert.equal(cancelled.optionsEnabled, true);
  assert.equal(cancelled.errorHidden, true);
  assert.equal(cancelled.toast, 'Render cancelled. No file was produced.');
  assert.equal(downloadEvents.length, 0);
  assert.deepEqual(readdirSync(downloadDirectory), []);
  record('workerCancellation', { ...cancelled, downloadEvents: 0, filesProduced: 0 });

  await selectOption('#export-bars', 4);
  await selectOption('#export-sample-rate', 48000);
  await click('#render-wav');
  await waitFor("!document.getElementById('render-result').hidden && !document.getElementById('download-wav').hidden", 180000);
  const rendered = await evaluate(`(() => ({
    filename: document.getElementById('download-wav').download,
    hrefIsBlob: document.getElementById('download-wav').href.startsWith('blob:'),
    duration: document.getElementById('result-duration').textContent,
    peak: document.getElementById('result-peak').textContent,
    rms: document.getElementById('result-rms').textContent,
    checksum: document.getElementById('result-checksum').textContent,
    progressHidden: document.getElementById('render-progress').hidden,
    renderEnabled: !document.getElementById('render-wav').disabled,
    renderLabel: document.getElementById('render-wav').textContent,
    footer: document.getElementById('footer-status').textContent
  }))()`);
  assert.equal(rendered.filename, EXPECTED_FILENAME);
  assert.equal(rendered.hrefIsBlob, true);
  assert.equal(rendered.duration, `${EXPECTED.workerMetrics.duration.toFixed(3)} s`);
  assert.equal(rendered.peak, '-2.2 dB');
  assert.equal(rendered.rms, '-16.8 dB');
  assert.equal(rendered.checksum, EXPECTED.workerMetrics.checksum);
  assert.equal(rendered.progressHidden, true);
  assert.equal(rendered.renderEnabled, true);
  assert.equal(rendered.renderLabel, 'Render again');
  assert.equal(rendered.footer, 'WAV rendered');

  const downloadStarted = waitEvent('Browser.downloadWillBegin');
  const downloadCompleted = waitEvent('Browser.downloadProgress', params => params.state === 'completed', 30000);
  await click('#download-wav');
  const started = await downloadStarted;
  const completed = await downloadCompleted;
  assert.equal(started.suggestedFilename, EXPECTED_FILENAME);
  const downloadedPath = path.join(downloadDirectory, started.suggestedFilename);
  assert.equal(existsSync(downloadedPath), true, 'Chrome did not save the WAV');
  const bytes = readFileSync(downloadedPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const checksum = fnv1a(bytes);
  const header = inspectWav(bytes);
  assert.equal(bytes.length, EXPECTED.wavComparison.realtimeVsWorker.expectedBytes);
  assert.equal(sha256, EXPECTED.sha256.workerWAV);
  assert.equal(checksum, EXPECTED.computedWorkerFNV1a);
  assert.equal(completed.totalBytes, bytes.length);
  const artifactWav = path.join(DOWNLOAD_ARTIFACTS, EXPECTED_FILENAME);
  copyFileSync(downloadedPath, artifactWav);
  record('workerRenderAndActualDownload', {
    ...rendered,
    download: path.relative(ROOT, artifactWav),
    suggestedFilename: started.suggestedFilename,
    receivedBytes: completed.receivedBytes,
    totalBytes: completed.totalBytes,
    fileBytes: bytes.length,
    sha256,
    fnv1a: checksum,
    expectedSha256: EXPECTED.sha256.workerWAV,
    matchesEstablishedParityWav: true,
    header,
    metrics: EXPECTED.workerMetrics
  });

  await click('#close-export');
  await click('#stop-button');
  for (const width of [320, 360, 390, 480]) await verifyLayout(width);

  if (KEEP_OPEN) {
    await send('Emulation.clearDeviceMetricsOverride');
    const { windowId } = await send('Browser.getWindowForTarget');
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await send('Browser.setWindowBounds', { windowId, bounds: { left: 30, top: 30, width: 1280, height: 960 } });
  } else await metrics(1280, 900, false);
  await evaluate("window.scrollTo({ top: 0, behavior: 'instant' }); true");
  await delay(150);
  report.finalState = await evaluate(`(() => ({
    url: location.href,
    title: document.title,
    project: document.getElementById('project-name').value,
    transport: document.getElementById('transport-state').textContent,
    position: document.getElementById('position-value').textContent,
    engine: document.getElementById('engine-badge').textContent.trim(),
    dialogsOpen: [...document.querySelectorAll('dialog')].filter(dialog => dialog.open).map(dialog => dialog.id),
    temporaryHooks: Object.keys(window).filter(key => /^__(rift|test|browser|cdp)/i.test(key)),
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth
  }))()`);
  assert.equal(report.finalState.project, 'Untitled signal');
  assert.equal(report.finalState.transport, 'Stopped');
  assert.equal(report.finalState.position, '1.1');
  assert.deepEqual(report.finalState.dialogsOpen, []);
  assert.deepEqual(report.finalState.temporaryHooks, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.failedRequests, []);
  assert.deepEqual(report.httpErrors, []);
  record('cleanBrowserAndFinalState', report.finalState);
  report.pass = true;
} catch (error) {
  report.error = error.stack || String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  saveReport();
  if (KEEP_OPEN && report.pass) {
    ws?.close();
    chrome?.stderr?.destroy();
    chrome?.unref();
    console.log(`Browser left open at ${PAGE_URL}; report: ${REPORT_PATH}`);
  } else {
    await closeBrowser();
    chrome?.stderr?.destroy();
  }
}

if (!report.pass) throw new Error(`Browser verification failed; see ${REPORT_PATH}`);
console.log(`Browser verification passed; report: ${REPORT_PATH}`);
