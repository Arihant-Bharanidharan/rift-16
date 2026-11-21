'use strict';

const DSP = globalThis.RiftDSP;
if (!DSP) throw new Error('RIFT/16 DSP core did not load.');

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'rift16.project.v1';
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const KEY_OFFSETS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k'];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const PARAMETER_META = [
  {
    tune: { label: 'Tune', step: 1, format: value => `${signed(Math.round(value))} st` },
    decay: { label: 'Decay', step: 0.01, format: formatSeconds },
    drive: { label: 'Drive', step: 0.01, format: formatPercent },
    click: { label: 'Transient click', step: 0.01, format: formatPercent }
  },
  {
    cutoff: { label: 'Filter cutoff', step: 10, format: formatFrequency },
    resonance: { label: 'Resonance', step: 0.1, format: value => `Q ${value.toFixed(1)}` },
    decay: { label: 'Decay', step: 0.01, format: formatSeconds },
    drive: { label: 'Drive', step: 0.01, format: formatPercent },
    sub: { label: 'Sub oscillator', step: 0.01, format: formatPercent }
  },
  {
    decay: { label: 'Decay', step: 0.01, format: formatSeconds },
    modulation: { label: 'FM index', step: 0.05, format: value => `${value.toFixed(2)}×` },
    detune: { label: 'Pair detune', step: 0.0005, format: value => `${(1200 * Math.log2(1 + value)).toFixed(1)} cents` },
    attack: { label: 'Attack', step: 0.001, format: value => `${Math.round(value * 1000)} ms` }
  },
  {
    cutoff: { label: 'Noise cutoff', step: 100, format: formatFrequency },
    decay: { label: 'Decay', step: 0.01, format: formatSeconds },
    tone: { label: 'Metallic tone', step: 0.01, format: formatPercent },
    drive: { label: 'Drive', step: 0.01, format: formatPercent }
  }
];

let storageWarning = '';
let state = loadProject();
let selectedTrack = 0;
let selectedStep = 0;
let currentStep = -1;
let isPlaying = false;
let hasStarted = false;
let transportBusy = false;
let transportGeneration = 0;
let saveTimer = 0;
let toastTimer = 0;
let audioContext = null;
let audioNode = null;
let audioInitPromise = null;
let audioReady = false;
let analyser = null;
let analyserLeft = null;
let analyserRight = null;
let scopeData = null;
let spectrumData = null;
let levelDataLeft = null;
let levelDataRight = null;
let displayedPeak = 0;
let renderWorker = null;
let downloadUrl = '';
const heldKeys = new Set();
const stepPads = [];
const trackRows = [];
const stepNumbers = [];

const scopeContext = $('scope-canvas').getContext('2d');
const spectrumContext = $('spectrum-canvas').getContext('2d');

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatSeconds(value) {
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
}

function formatFrequency(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`;
}

function noteName(note) {
  const midi = Math.round(note);
  return `${NOTE_NAMES[(midi % 12 + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function dbLabel(peak) {
  return peak > 0.00001 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : '−∞ dB';
}

function setRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const fraction = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${Math.min(100, Math.max(0, fraction * 100))}%`);
}

function loadProject() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? DSP.normalizeState(JSON.parse(saved)) : DSP.createDefaultState();
  } catch (error) {
    storageWarning = 'The saved project could not be read; defaults were restored.';
    return DSP.createDefaultState();
  }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $('save-state').textContent = 'Saved locally';
    return true;
  } catch (error) {
    $('save-state').textContent = 'Save unavailable';
    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  $('save-state').textContent = 'Saving…';
  saveTimer = window.setTimeout(saveNow, 400);
}

function syncAudio() {
  if (audioNode && audioReady) audioNode.port.postMessage({ type: 'state', state });
}

function commitState() {
  syncAudio();
  scheduleSave();
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('visible');
  toastTimer = window.setTimeout(() => element.classList.remove('visible'), 3200);
}

function setEngineStatus(label, status = '') {
  const badge = $('engine-badge');
  badge.classList.toggle('running', status === 'running');
  badge.classList.toggle('error', status === 'error');
  badge.innerHTML = `<i></i> ${label}`;
}

function buildSequencer() {
  const fragment = document.createDocumentFragment();
  for (let step = 0; step < DSP.STEP_COUNT; step++) {
    const number = document.createElement('div');
    number.className = `step-number${step % 4 === 0 ? ' beat' : ''}`;
    number.textContent = String(step + 1).padStart(2, '0');
    stepNumbers.push(number);
    fragment.append(number);
  }
  $('step-numbers').append(fragment);

  DSP.TRACK_INFO.forEach((info, trackIndex) => {
    const row = document.createElement('div');
    row.className = 'track-row';
    row.dataset.track = String(trackIndex);
    row.style.setProperty('--track', info.color);

    const control = document.createElement('div');
    control.className = 'track-control';
    control.innerHTML = `
      <button class="track-select" type="button" data-action="select" data-track="${trackIndex}" aria-label="Select ${info.name}">
        <span class="track-index">0${trackIndex + 1}</span>
        <span class="track-identity"><strong>${info.name}</strong><span>${info.role}</span></span>
      </button>
      <div class="track-actions">
        <button class="track-action" type="button" data-action="mute" data-track="${trackIndex}" aria-label="Mute ${info.name}" aria-pressed="false">M</button>
        <button class="track-action" type="button" data-action="solo" data-track="${trackIndex}" aria-label="Solo ${info.name}" aria-pressed="false">S</button>
        <button class="track-action track-audition" type="button" data-action="audition" data-track="${trackIndex}" aria-label="Audition ${info.name}">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2zM11 5c1.5 1.5 1.5 4.5 0 6"/></svg>
        </button>
      </div>`;

    const steps = document.createElement('div');
    steps.className = 'steps';
    const pads = [];
    for (let stepIndex = 0; stepIndex < DSP.STEP_COUNT; stepIndex++) {
      const pad = document.createElement('button');
      pad.className = 'step-pad';
      pad.type = 'button';
      pad.dataset.track = String(trackIndex);
      pad.dataset.step = String(stepIndex);
      pad.innerHTML = `<span class="step-note"></span><span class="step-glyph" aria-hidden="true"></span>`;
      pads.push(pad);
      steps.append(pad);
    }
    stepPads.push(pads);
    trackRows.push(row);
    row.append(control, steps);
    $('track-list').append(row);
  });
}

function updatePattern() {
  let activeCount = 0;
  state.tracks.forEach((track, trackIndex) => {
    const row = trackRows[trackIndex];
    row.classList.toggle('selected', trackIndex === selectedTrack);
    row.classList.toggle('muted', track.mute);
    for (const action of ['mute', 'solo']) {
      const button = row.querySelector(`[data-action="${action}"]`);
      button.classList.toggle('active', track[action]);
      button.setAttribute('aria-pressed', String(track[action]));
    }
    track.steps.forEach((step, stepIndex) => {
      if (step.active) activeCount++;
      const pad = stepPads[trackIndex][stepIndex];
      pad.classList.toggle('active', step.active);
      pad.classList.toggle('selected', trackIndex === selectedTrack && stepIndex === selectedStep);
      pad.style.setProperty('--velocity', String(step.velocity));
      pad.setAttribute('aria-pressed', String(step.active));
      pad.setAttribute('aria-label', `${DSP.TRACK_INFO[trackIndex].name} step ${stepIndex + 1}, ${step.active ? 'enabled' : 'disabled'}, velocity ${Math.round(step.velocity * 100)} percent, pitch ${signed(step.note)} semitones`);
      pad.title = `Step ${String(stepIndex + 1).padStart(2, '0')} · ${Math.round(step.velocity * 100)}% · ${signed(step.note)} st`;
      pad.querySelector('.step-note').textContent = signed(step.note);
    });
  });
  $('pattern-summary').textContent = `${activeCount} / 64 active`;
  updatePlayhead(currentStep);
}

function updatePlayhead(step) {
  currentStep = Number.isInteger(step) ? step : -1;
  stepNumbers.forEach((number, index) => number.classList.toggle('playing', index === currentStep));
  stepPads.forEach(pads => pads.forEach((pad, index) => pad.classList.toggle('playing', index === currentStep)));
  const positionStep = currentStep >= 0 ? currentStep : 0;
  $('position-value').textContent = `${Math.floor(positionStep / 4) + 1}.${positionStep % 4 + 1}`;
}

function makeParameter(container, options) {
  const row = document.createElement('div');
  row.className = 'parameter-row';
  const inputId = `parameter-${options.id}`;
  const outputId = `${inputId}-value`;
  const label = document.createElement('div');
  label.className = 'control-label';
  const labelElement = document.createElement('label');
  labelElement.htmlFor = inputId;
  labelElement.textContent = options.label;
  const output = document.createElement('output');
  output.id = outputId;
  output.htmlFor = inputId;
  output.value = options.format(options.value);
  label.append(labelElement, output);

  const input = document.createElement('input');
  input.id = inputId;
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.value = String(options.value);
  input.setAttribute('aria-describedby', outputId);
  setRangeFill(input);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    output.value = options.format(value);
    setRangeFill(input);
    options.onInput(value);
    commitState();
  });
  row.append(label, input);
  container.append(row);
  return input;
}

function buildVoiceControls() {
  const voiceContainer = $('voice-params');
  const channelContainer = $('channel-params');
  voiceContainer.replaceChildren();
  channelContainer.replaceChildren();
  voiceContainer.style.setProperty('--track', DSP.TRACK_INFO[selectedTrack].color);
  channelContainer.style.setProperty('--track', DSP.TRACK_INFO[selectedTrack].color);
  const track = state.tracks[selectedTrack];

  Object.entries(track.params).forEach(([key, value]) => {
    const [min, max] = DSP.PARAM_RANGES[selectedTrack][key];
    const meta = PARAMETER_META[selectedTrack][key];
    makeParameter(voiceContainer, {
      id: `${track.id}-${key}`,
      label: meta.label,
      min,
      max,
      step: meta.step,
      value,
      format: meta.format,
      onInput: next => { state.tracks[selectedTrack].params[key] = next; }
    });
  });

  const channelParameters = [
    { key: 'level', label: 'Level', min: 0, max: 1, step: 0.01, format: formatPercent },
    { key: 'pan', label: 'Pan', min: -1, max: 1, step: 0.01, format: value => Math.abs(value) < 0.005 ? 'Center' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'L' : 'R'}` },
    { key: 'send', label: 'Delay send', min: 0, max: 1, step: 0.01, format: formatPercent }
  ];
  channelParameters.forEach(meta => {
    makeParameter(channelContainer, {
      id: `${track.id}-${meta.key}`,
      ...meta,
      value: track[meta.key],
      onInput: next => { state.tracks[selectedTrack][meta.key] = next; }
    });
  });
}

function updateStepInspector() {
  const info = DSP.TRACK_INFO[selectedTrack];
  const step = state.tracks[selectedTrack].steps[selectedStep];
  $('step-track-name').textContent = info.name;
  $('step-edit-title').textContent = `Step ${String(selectedStep + 1).padStart(2, '0')}`;
  $('step-enabled').checked = step.active;
  $('step-note').value = String(step.note);
  $('step-note-value').value = `${signed(step.note)} st`;
  $('step-velocity').value = String(step.velocity);
  $('step-velocity-value').value = formatPercent(step.velocity);
  const note = info.baseNote + step.note;
  $('step-note-detail').textContent = `${noteName(note)} · ${DSP.midiToFreq(note).toFixed(2)} Hz fundamental`;
  setRangeFill($('step-note'));
  setRangeFill($('step-velocity'));
}

function updateKeyboard() {
  const info = DSP.TRACK_INFO[selectedTrack];
  $('keyboard-target').textContent = `${info.name} · ${noteName(info.baseNote)}`;
  $('keyboard').querySelectorAll('.key-button').forEach(button => {
    const offset = Number(button.dataset.offset);
    const note = info.baseNote + offset;
    button.setAttribute('aria-label', `Audition ${info.name}, ${noteName(note)}, key ${KEY_OFFSETS[offset].toUpperCase()}`);
    button.querySelector('span').textContent = `${noteName(note)} · ${KEY_OFFSETS[offset].toUpperCase()}`;
  });
}

function updateInspector() {
  const info = DSP.TRACK_INFO[selectedTrack];
  $('inspector-track').textContent = info.name;
  $('inspector-engine').textContent = info.role;
  $('inspector-color').style.background = info.color;
  $('panel-rhythm').style.setProperty('--track', info.color);
  $('panel-step').style.setProperty('--track', info.color);
  updateStepInspector();
  updateKeyboard();
}

function selectTrack(trackIndex) {
  if (trackIndex < 0 || trackIndex >= DSP.TRACK_INFO.length) return;
  selectedTrack = trackIndex;
  buildVoiceControls();
  updatePattern();
  updateInspector();
}

function activateTab(name, focus = false) {
  document.querySelectorAll('.inspector-tabs [role="tab"]').forEach(tab => {
    const active = tab.dataset.panel === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`panel-${tab.dataset.panel}`).hidden = !active;
    if (active && focus) tab.focus();
  });
}

function buildKeyboard() {
  const fragment = document.createDocumentFragment();
  KEY_OFFSETS.forEach((key, offset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `key-button${BLACK_KEYS.has(offset) ? ' black' : ''}`;
    button.dataset.offset = String(offset);
    const label = document.createElement('span');
    button.append(label);
    button.addEventListener('pointerdown', event => {
      event.preventDefault();
      button.classList.add('pressed');
      audition(selectedTrack, offset, 0.85);
    });
    button.addEventListener('click', event => {
      // Native keyboard and assistive-technology activation has no pointer detail.
      if (event.detail === 0) audition(selectedTrack, offset, 0.85);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
      button.addEventListener(eventName, () => button.classList.remove('pressed'));
    }
    fragment.append(button);
  });
  $('keyboard').append(fragment);
}

function updateTransport() {
  $('project-name').value = state.name;
  $('tempo').value = String(Math.round(state.bpm));
  $('swing').value = String(state.swing);
  $('swing-value').value = formatPercent(state.swing);
  $('master').value = String(state.master);
  $('master-value').value = formatPercent(state.master);
  $('delay-time').value = String(state.delay.time);
  $('delay-time-value').value = `${state.delay.time.toFixed(2)} beats`;
  $('delay-feedback').value = String(state.delay.feedback);
  $('delay-feedback-value').value = formatPercent(state.delay.feedback);
  $('delay-mix').value = String(state.delay.mix);
  $('delay-mix-value').value = formatPercent(state.delay.mix);
  ['swing', 'master', 'delay-time', 'delay-feedback', 'delay-mix'].forEach(id => setRangeFill($(id)));
  updateDelayDetail();
  updateTransportButtons();
  updateExportEstimate();
}

function updateTransportButtons() {
  $('play-button').classList.toggle('playing', isPlaying);
  $('play-button').setAttribute('aria-label', isPlaying ? 'Pause pattern' : hasStarted ? 'Resume pattern' : 'Play pattern');
  $('play-icon').innerHTML = isPlaying ? '<path d="M5 4h4v12H5zM11 4h4v12h-4z"/>' : '<path d="m6 3 11 7-11 7z"/>';
  $('play-label').textContent = isPlaying ? 'Pause' : hasStarted ? 'Resume' : 'Play';
  $('transport-state').textContent = isPlaying ? 'Playing' : hasStarted ? 'Paused' : 'Stopped';
}

function updateDelayDetail() {
  $('delay-time-detail').textContent = `${Math.round(state.delay.time * 60 / state.bpm * 1000)} ms at ${Math.round(state.bpm)} BPM`;
}

async function initializeAudio() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser does not support Web Audio.');
  setEngineStatus('Starting audio…');
  audioContext = new AudioContextClass({ latencyHint: 'interactive' });
  const resumeOnGesture = audioContext.state === 'suspended' ? audioContext.resume() : Promise.resolve();
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  await resumeOnGesture;

  audioNode = new AudioWorkletNode(audioContext, 'rift-engine', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimeout = window.setTimeout(() => rejectReady(new Error('The audio engine did not become ready.')), 10000);

  audioNode.port.onmessage = event => {
    const message = event.data || {};
    if (message.type === 'ready') {
      clearTimeout(readyTimeout);
      audioReady = true;
      $('sample-rate-value').textContent = `Sample rate ${message.sampleRate.toLocaleString()} Hz`;
      resolveReady();
    } else if (message.type === 'position') {
      const wasPlaying = isPlaying;
      isPlaying = !!message.playing;
      if (!isPlaying && wasPlaying) hasStarted = true;
      updatePlayhead(message.step);
      updateTransportButtons();
    }
  };
  audioNode.port.onmessageerror = () => toast('The audio engine received an invalid message.', true);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.76;
  analyserLeft = audioContext.createAnalyser();
  analyserRight = audioContext.createAnalyser();
  analyserLeft.fftSize = 2048;
  analyserRight.fftSize = 2048;
  const splitter = audioContext.createChannelSplitter(2);
  audioNode.connect(analyser);
  analyser.connect(audioContext.destination);
  audioNode.connect(splitter);
  splitter.connect(analyserLeft, 0);
  splitter.connect(analyserRight, 1);
  scopeData = new Float32Array(analyser.fftSize);
  spectrumData = new Uint8Array(analyser.frequencyBinCount);
  levelDataLeft = new Float32Array(analyserLeft.fftSize);
  levelDataRight = new Float32Array(analyserRight.fftSize);

  audioContext.onstatechange = () => {
    if (!audioContext) return;
    if (audioContext.state === 'running') setEngineStatus('Audio running', 'running');
    else if (audioContext.state !== 'closed') setEngineStatus('Audio suspended');
  };
  await ready;
  syncAudio();
  if (audioContext.state === 'suspended') await audioContext.resume();
  setEngineStatus(audioContext.state === 'running' ? 'Audio running' : 'Audio suspended', audioContext.state === 'running' ? 'running' : '');
}

async function ensureAudio() {
  try {
    if (!audioInitPromise) audioInitPromise = initializeAudio();
    await audioInitPromise;
    if (audioContext.state === 'suspended') await audioContext.resume();
    return true;
  } catch (error) {
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {});
    audioContext = null;
    audioNode = null;
    audioInitPromise = null;
    audioReady = false;
    analyser = null;
    analyserLeft = null;
    analyserRight = null;
    setEngineStatus('Audio error', 'error');
    $('footer-status').textContent = 'Audio unavailable';
    toast(error && error.message ? error.message : String(error), true);
    throw error;
  }
}

function audition(trackIndex, note = 0, velocity = 0.85) {
  ensureAudio().then(() => {
    audioNode.port.postMessage({ type: 'audition', track: trackIndex, note, velocity });
  }).catch(() => {});
}

async function togglePlayback() {
  if (transportBusy) return;
  if (isPlaying) {
    if (audioNode && audioReady) audioNode.port.postMessage({ type: 'transport', action: 'pause' });
    isPlaying = false;
    hasStarted = true;
    updateTransportButtons();
    return;
  }

  transportBusy = true;
  const generation = transportGeneration;
  $('play-button').setAttribute('aria-busy', 'true');
  try {
    await ensureAudio();
    if (generation !== transportGeneration) return;
    const action = hasStarted ? 'resume' : 'play';
    audioNode.port.postMessage({ type: 'transport', action });
    isPlaying = true;
    hasStarted = true;
    $('footer-status').textContent = action === 'play' ? 'Playing' : 'Resumed';
    updateTransportButtons();
  } catch (error) {
    // ensureAudio has already surfaced the concrete failure.
  } finally {
    transportBusy = false;
    $('play-button').removeAttribute('aria-busy');
  }
}

function stopPlayback() {
  transportGeneration++;
  if (audioNode && audioReady) audioNode.port.postMessage({ type: 'transport', action: 'stop' });
  isPlaying = false;
  hasStarted = false;
  updatePlayhead(-1);
  updateTransportButtons();
  $('footer-status').textContent = 'Stopped';
}

function updateEuclideanPreview() {
  const hits = Number($('euclid-hits').value);
  const rotation = Number($('euclid-rotation').value);
  const rhythm = DSP.euclidean(hits, 16, rotation);
  $('euclid-hits-value').value = `${hits} / 16`;
  $('euclid-rotation-value').value = `${rotation} ${rotation === 1 ? 'step' : 'steps'}`;
  setRangeFill($('euclid-hits'));
  setRangeFill($('euclid-rotation'));
  const cells = $('euclid-preview').children;
  rhythm.forEach((active, index) => cells[index].classList.toggle('active', active));
  $('euclid-preview').setAttribute('aria-label', `${hits} triggers across 16 steps, rotated ${rotation} steps`);
}

function buildEuclideanPreview() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 16; index++) {
    const cell = document.createElement('span');
    cell.className = 'euclid-cell';
    cell.setAttribute('aria-hidden', 'true');
    fragment.append(cell);
  }
  $('euclid-preview').append(fragment);
  updateEuclideanPreview();
}

function resizeCanvas(canvas, context) {
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { context, width, height };
}

function drawGrid(context, width, height) {
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#292c24';
  context.lineWidth = 1;
  context.beginPath();
  for (let index = 1; index < 4; index++) {
    const y = Math.round(height * index / 4) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  for (let index = 1; index < 8; index++) {
    const x = Math.round(width * index / 8) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  context.stroke();
}

function drawAnalysis() {
  requestAnimationFrame(drawAnalysis);
  const scope = resizeCanvas($('scope-canvas'), scopeContext);
  const spectrum = resizeCanvas($('spectrum-canvas'), spectrumContext);
  drawGrid(scope.context, scope.width, scope.height);
  drawGrid(spectrum.context, spectrum.width, spectrum.height);

  const running = analyser && audioContext && audioContext.state === 'running';
  let peakLeft = 0;
  let peakRight = 0;
  if (running) {
    analyser.getFloatTimeDomainData(scopeData);
    analyser.getByteFrequencyData(spectrumData);
    analyserLeft.getFloatTimeDomainData(levelDataLeft);
    analyserRight.getFloatTimeDomainData(levelDataRight);
    for (let index = 0; index < levelDataLeft.length; index++) {
      peakLeft = Math.max(peakLeft, Math.abs(levelDataLeft[index]));
      peakRight = Math.max(peakRight, Math.abs(levelDataRight[index]));
    }
  } else if (scopeData) {
    scopeData.fill(0);
    spectrumData.fill(0);
  }

  scope.context.strokeStyle = '#efba67';
  scope.context.lineWidth = Math.max(1, scope.width / 500);
  scope.context.beginPath();
  const samples = scopeData ? scopeData.length : 0;
  for (let index = 0; index < samples; index++) {
    const x = index / (samples - 1) * scope.width;
    const y = scope.height * (0.5 - scopeData[index] * 0.43);
    if (index === 0) scope.context.moveTo(x, y);
    else scope.context.lineTo(x, y);
  }
  if (samples) scope.context.stroke();

  if (spectrumData) {
    const barCount = Math.max(20, Math.min(80, Math.floor(spectrum.width / 6)));
    const barWidth = spectrum.width / barCount;
    spectrum.context.fillStyle = '#70d6cb';
    for (let bar = 0; bar < barCount; bar++) {
      const start = Math.floor((bar / barCount) ** 2 * (spectrumData.length - 1));
      const end = Math.max(start + 1, Math.floor(((bar + 1) / barCount) ** 2 * spectrumData.length));
      let total = 0;
      for (let index = start; index < end; index++) total += spectrumData[index];
      const value = total / (end - start) / 255;
      const height = value * spectrum.height * 0.9;
      spectrum.context.fillRect(bar * barWidth + 1, spectrum.height - height, Math.max(1, barWidth - 2), height);
    }
  }

  displayedPeak = Math.max(peakLeft, peakRight, displayedPeak * 0.94);
  if (displayedPeak < 0.000001) displayedPeak = 0;
  $('peak-value').textContent = dbLabel(displayedPeak);
  $('meter-left').style.transform = `scaleY(${Math.min(1, peakLeft)})`;
  $('meter-right').style.transform = `scaleY(${Math.min(1, peakRight)})`;
}

function updateExportEstimate() {
  if (!$('export-bars')) return;
  const bars = Number($('export-bars').value);
  const sampleRate = Number($('export-sample-rate').value);
  const bodySeconds = bars * 16 * 60 / state.bpm / 4;
  const bodyBytes = 44 + Math.ceil(bodySeconds * sampleRate) * 4;
  $('export-estimate').textContent = `Body ${bodySeconds.toFixed(2)} s · ${(bodyBytes / 1000000).toFixed(1)} MB + tail`;
}

function clearDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = '';
  $('download-wav').hidden = true;
  $('download-wav').removeAttribute('href');
  $('render-result').hidden = true;
}

function finishRenderControls() {
  $('render-wav').disabled = false;
  $('export-bars').disabled = false;
  $('export-sample-rate').disabled = false;
  $('cancel-render').hidden = true;
}

function cancelRender(notify = false) {
  if (!renderWorker) return;
  renderWorker.terminate();
  renderWorker = null;
  $('render-progress').hidden = true;
  finishRenderControls();
  if (notify) toast('Render cancelled. No file was produced.');
}

function renderWav() {
  cancelRender();
  clearDownload();
  $('export-error').hidden = true;
  $('render-progress').hidden = false;
  $('render-status').textContent = 'Rendering samples';
  $('render-percent').value = '0%';
  $('export-progress').value = 0;
  $('render-wav').disabled = true;
  $('export-bars').disabled = true;
  $('export-sample-rate').disabled = true;
  $('cancel-render').hidden = false;

  const bars = Number($('export-bars').value);
  const sampleRate = Number($('export-sample-rate').value);
  const snapshot = DSP.normalizeState(state);
  const worker = new Worker('/src/export-worker.js');
  renderWorker = worker;

  const fail = message => {
    if (renderWorker !== worker) return;
    worker.terminate();
    renderWorker = null;
    $('render-progress').hidden = true;
    $('export-error').textContent = message;
    $('export-error').hidden = false;
    finishRenderControls();
  };

  worker.onmessage = event => {
    if (renderWorker !== worker) return;
    const message = event.data || {};
    if (message.type === 'progress') {
      const progress = Math.max(0, Math.min(1, Number(message.progress) || 0));
      $('export-progress').value = progress;
      $('render-percent').value = `${Math.round(progress * 100)}%`;
    } else if (message.type === 'error') {
      fail(message.message || 'The render failed.');
    } else if (message.type === 'complete') {
      const metrics = message.metrics;
      const blob = new Blob([message.wav], { type: 'audio/wav' });
      downloadUrl = URL.createObjectURL(blob);
      const safeName = (state.name.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'rift-16');
      $('download-wav').href = downloadUrl;
      $('download-wav').download = `${safeName}-${bars}bars-${sampleRate}Hz.wav`;
      $('download-wav').hidden = false;
      $('result-duration').textContent = `${metrics.duration.toFixed(3)} s`;
      $('result-peak').textContent = dbLabel(metrics.peak);
      $('result-rms').textContent = dbLabel(metrics.rms);
      $('result-checksum').textContent = metrics.checksum;
      $('render-result').hidden = false;
      $('render-progress').hidden = true;
      worker.terminate();
      renderWorker = null;
      finishRenderControls();
      $('render-wav').textContent = 'Render again';
      $('footer-status').textContent = 'WAV rendered';
    }
  };
  worker.onerror = event => {
    event.preventDefault();
    fail(event.message || 'The export worker failed to start.');
  };
  worker.postMessage({ type: 'render', state: snapshot, bars, sampleRate });
}

function resetProject() {
  cancelRender();
  clearDownload();
  stopPlayback();
  state = DSP.createDefaultState();
  selectedTrack = 0;
  selectedStep = 0;
  $('project-name').value = state.name;
  buildVoiceControls();
  updateTransport();
  updatePattern();
  updateInspector();
  activateTab('voice');
  commitState();
  $('new-dialog').close();
  $('footer-status').textContent = 'New project';
  toast('New project created. The previous local project was replaced.');
}

function bindEvents() {
  $('play-button').addEventListener('click', togglePlayback);
  $('stop-button').addEventListener('click', stopPlayback);
  $('tempo-down').addEventListener('click', () => {
    state.bpm = Math.max(60, Math.round(state.bpm) - 1);
    updateTransport();
    commitState();
  });
  $('tempo-up').addEventListener('click', () => {
    state.bpm = Math.min(180, Math.round(state.bpm) + 1);
    updateTransport();
    commitState();
  });
  $('tempo').addEventListener('change', () => {
    const value = Number($('tempo').value);
    state.bpm = Number.isFinite(value) ? DSP.clamp(Math.round(value), 60, 180) : state.bpm;
    updateTransport();
    commitState();
  });
  $('project-name').addEventListener('input', () => {
    state.name = $('project-name').value.slice(0, 80);
    commitState();
  });

  for (const [id, key] of [['swing', 'swing'], ['master', 'master']]) {
    $(id).addEventListener('input', () => {
      state[key] = Number($(id).value);
      $(`${id}-value`).value = formatPercent(state[key]);
      setRangeFill($(id));
      commitState();
    });
  }
  for (const [id, key] of [['delay-time', 'time'], ['delay-feedback', 'feedback'], ['delay-mix', 'mix']]) {
    $(id).addEventListener('input', () => {
      state.delay[key] = Number($(id).value);
      $(`${id}-value`).value = key === 'time' ? `${state.delay[key].toFixed(2)} beats` : formatPercent(state.delay[key]);
      setRangeFill($(id));
      if (key === 'time') updateDelayDetail();
      commitState();
    });
  }

  $('track-list').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const trackIndex = Number(button.dataset.track);
    if (!Number.isInteger(trackIndex)) return;
    if (button.classList.contains('step-pad')) {
      selectedStep = Number(button.dataset.step);
      const changedTrack = selectedTrack !== trackIndex;
      selectedTrack = trackIndex;
      const step = state.tracks[trackIndex].steps[selectedStep];
      step.active = !step.active;
      if (changedTrack) buildVoiceControls();
      updatePattern();
      updateInspector();
      commitState();
      return;
    }
    const action = button.dataset.action;
    if (action === 'select') selectTrack(trackIndex);
    else if (action === 'audition') audition(trackIndex);
    else if (action === 'mute' || action === 'solo') {
      state.tracks[trackIndex][action] = !state.tracks[trackIndex][action];
      updatePattern();
      commitState();
    }
  });

  document.querySelectorAll('.inspector-tabs [role="tab"]').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.panel));
    tab.addEventListener('keydown', event => {
      const tabs = [...document.querySelectorAll('.inspector-tabs [role="tab"]')];
      const index = tabs.indexOf(tab);
      let next = -1;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        event.preventDefault();
        activateTab(tabs[next].dataset.panel, true);
      }
    });
  });

  $('audition-track').addEventListener('click', () => audition(selectedTrack));
  $('audition-step').addEventListener('click', () => {
    const step = state.tracks[selectedTrack].steps[selectedStep];
    audition(selectedTrack, step.note, step.velocity);
  });
  $('step-enabled').addEventListener('change', () => {
    state.tracks[selectedTrack].steps[selectedStep].active = $('step-enabled').checked;
    updatePattern();
    commitState();
  });
  $('step-note').addEventListener('input', () => {
    const step = state.tracks[selectedTrack].steps[selectedStep];
    step.note = Number($('step-note').value);
    updateStepInspector();
    updatePattern();
    commitState();
  });
  $('step-velocity').addEventListener('input', () => {
    const step = state.tracks[selectedTrack].steps[selectedStep];
    step.velocity = Number($('step-velocity').value);
    updateStepInspector();
    updatePattern();
    commitState();
  });

  $('euclid-hits').addEventListener('input', updateEuclideanPreview);
  $('euclid-rotation').addEventListener('input', updateEuclideanPreview);
  $('apply-euclid').addEventListener('click', () => {
    const rhythm = DSP.euclidean(Number($('euclid-hits').value), 16, Number($('euclid-rotation').value));
    state.tracks[selectedTrack].steps.forEach((step, index) => { step.active = rhythm[index]; });
    updatePattern();
    updateStepInspector();
    commitState();
    toast(`${DSP.TRACK_INFO[selectedTrack].name}: ${rhythm.filter(Boolean).length} Euclidean triggers applied.`);
  });
  $('clear-track').addEventListener('click', () => {
    state.tracks[selectedTrack].steps.forEach(step => { step.active = false; });
    updatePattern();
    updateStepInspector();
    commitState();
    toast(`${DSP.TRACK_INFO[selectedTrack].name} cleared. Pitch and velocity settings were retained.`);
  });

  $('new-project').addEventListener('click', () => $('new-dialog').showModal());
  $('close-new').addEventListener('click', () => $('new-dialog').close());
  $('cancel-new').addEventListener('click', () => $('new-dialog').close());
  $('confirm-new').addEventListener('click', resetProject);
  $('open-export').addEventListener('click', () => {
    cancelRender();
    clearDownload();
    $('export-error').hidden = true;
    updateExportEstimate();
    $('export-dialog').showModal();
  });
  $('close-export').addEventListener('click', () => $('export-dialog').close());
  $('export-dialog').addEventListener('close', () => cancelRender());
  $('export-bars').addEventListener('change', updateExportEstimate);
  $('export-sample-rate').addEventListener('change', updateExportEstimate);
  $('render-wav').addEventListener('click', renderWav);
  $('cancel-render').addEventListener('click', () => cancelRender(true));

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      toast(saveNow() ? 'Project saved locally.' : 'Browser storage is unavailable.', !saveNow());
      return;
    }
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (editing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    if (event.code === 'Space') {
      if (target instanceof HTMLElement && /^(BUTTON|A)$/.test(target.tagName)) return;
      event.preventDefault();
      if (!event.repeat) togglePlayback();
      return;
    }
    const offset = KEY_OFFSETS.indexOf(event.key.toLowerCase());
    if (offset >= 0 && !event.repeat && !heldKeys.has(event.key.toLowerCase())) {
      event.preventDefault();
      heldKeys.add(event.key.toLowerCase());
      const button = $('keyboard').querySelector(`[data-offset="${offset}"]`);
      button.classList.add('pressed');
      audition(selectedTrack, offset, 0.85);
    }
  });
  document.addEventListener('keyup', event => {
    const key = event.key.toLowerCase();
    heldKeys.delete(key);
    const offset = KEY_OFFSETS.indexOf(key);
    if (offset >= 0) $('keyboard').querySelector(`[data-offset="${offset}"]`).classList.remove('pressed');
  });
  window.addEventListener('blur', () => {
    heldKeys.clear();
    $('keyboard').querySelectorAll('.pressed').forEach(button => button.classList.remove('pressed'));
  });
  window.addEventListener('beforeunload', () => {
    saveNow();
    cancelRender();
    clearDownload();
  });
}

buildSequencer();
buildKeyboard();
buildEuclideanPreview();
buildVoiceControls();
updateTransport();
updatePattern();
updateInspector();
bindEvents();
requestAnimationFrame(drawAnalysis);
if (storageWarning) toast(storageWarning, true);
