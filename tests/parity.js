const DSP = globalThis.RiftDSP;
const runButton = document.getElementById('run');
const status = document.getElementById('status');
const output = document.getElementById('output');
const download = document.getElementById('download');
let downloadUrl = '';

function fnv1a(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function compareFloat32(expected, actual) {
  if (expected.length !== actual.length) {
    return { equal: false, expectedFrames: expected.length, actualFrames: actual.length };
  }
  const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
  const actualBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  let mismatches = 0;
  let firstMismatch = null;
  let maxAbsoluteDifference = 0;
  for (let i = 0; i < expected.length; i++) {
    const difference = Math.abs(expected[i] - actual[i]);
    if (difference > maxAbsoluteDifference) maxAbsoluteDifference = difference;
    if (expectedBits[i] !== actualBits[i]) {
      mismatches++;
      if (!firstMismatch) {
        firstMismatch = {
          frame: i,
          expected: expected[i],
          actual: actual[i],
          expectedBits: expectedBits[i].toString(16).padStart(8, '0'),
          actualBits: actualBits[i].toString(16).padStart(8, '0')
        };
      }
    }
  }
  return {
    equal: mismatches === 0,
    frames: expected.length,
    mismatches,
    maxAbsoluteDifference,
    firstMismatch
  };
}

function compareBytes(expected, actual) {
  const length = Math.min(expected.length, actual.length);
  let mismatches = expected.length === actual.length ? 0 : Math.abs(expected.length - actual.length);
  let firstMismatch = expected.length === actual.length ? null : { byte: length };
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      mismatches++;
      if (!firstMismatch) firstMismatch = { byte: i, expected: expected[i], actual: actual[i] };
    }
  }
  return {
    equal: mismatches === 0,
    expectedBytes: expected.length,
    actualBytes: actual.length,
    mismatches,
    firstMismatch
  };
}

function renderWorker(state, sampleRate, bars) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/src/export-worker.js');
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Worker render timed out.'));
    }, 60000);
    worker.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'complete') {
        clearTimeout(timeout);
        worker.terminate();
        resolve(message);
      } else if (message.type === 'error') {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error(message.message || 'Worker render failed.'));
      }
    };
    worker.onerror = event => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || 'Worker failed to start.'));
    };
    worker.postMessage({ type: 'render', state, sampleRate, bars });
  });
}

async function captureRealtime(context, state, bars, frames) {
  await context.audioWorklet.addModule('/audio-worklet.js');
  const node = new AudioWorkletNode(context, 'rift-engine', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const monitor = context.createGain();
  monitor.gain.value = 0;
  node.connect(monitor);
  monitor.connect(context.destination);

  try {
    const captured = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Real-time capture timed out.')), Math.ceil(frames / context.sampleRate * 1000) + 15000);
      node.port.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'capture-complete') {
          clearTimeout(timeout);
          resolve(message);
        }
      };
      node.port.onmessageerror = () => {
        clearTimeout(timeout);
        reject(new Error('The real-time capture message could not be read.'));
      };
    });
    node.port.postMessage({ type: 'state', state });
    node.port.postMessage({ type: 'capture', frames });
    node.port.postMessage({ type: 'transport', action: 'play', stepLimit: bars * DSP.STEP_COUNT });
    return await captured;
  } finally {
    node.disconnect();
    monitor.disconnect();
    node.port.close();
  }
}

function setResult(result) {
  globalThis.__riftParity = result;
  output.textContent = JSON.stringify(result, null, 2);
  status.textContent = result.pass ? 'PASS — exact float and WAV parity.' : 'FAIL — inspect the JSON evidence.';
  status.className = result.pass ? 'pass' : 'fail';
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  download.href = downloadUrl;
  download.download = `rift16-parity-${result.sampleRate || 'unknown'}Hz.json`;
  download.hidden = false;
}

async function run() {
  runButton.disabled = true;
  download.hidden = true;
  globalThis.__riftParity = { pass: false, status: 'running' };
  let context;
  try {
    status.className = '';
    status.textContent = 'Starting the production AudioWorklet…';
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await context.resume();
    const sampleRate = context.sampleRate;
    const bars = 4;
    const state = DSP.normalizeState(DSP.createDefaultState());

    status.textContent = 'Rendering the direct offline reference…';
    const offline = DSP.renderSong(state, { sampleRate, bars });
    const offlineWav = DSP.encodeWAV(offline.left, offline.right, sampleRate);

    status.textContent = 'Rendering the actual export Worker WAV…';
    const worker = await renderWorker(state, sampleRate, bars);

    status.textContent = `Capturing ${offline.frames.toLocaleString()} real-time frames (${(offline.frames / sampleRate).toFixed(3)} s)…`;
    const realtime = await captureRealtime(context, state, bars, offline.frames);
    const realtimeWav = DSP.encodeWAV(realtime.left, realtime.right, sampleRate);

    status.textContent = 'Comparing Float32 bit patterns and WAV bytes…';
    const floatComparison = {
      realtimeVsOfflineLeft: compareFloat32(offline.left, realtime.left),
      realtimeVsOfflineRight: compareFloat32(offline.right, realtime.right)
    };
    const wavComparison = {
      realtimeVsWorker: compareBytes(new Uint8Array(worker.wav), new Uint8Array(realtimeWav)),
      realtimeVsDirectOffline: compareBytes(new Uint8Array(offlineWav), new Uint8Array(realtimeWav)),
      workerVsDirectOffline: compareBytes(new Uint8Array(offlineWav), new Uint8Array(worker.wav))
    };
    const comparisons = [...Object.values(floatComparison), ...Object.values(wavComparison)];
    const checksum = fnv1a(new Uint8Array(worker.wav));
    const result = {
      pass: comparisons.every(comparison => comparison.equal) && checksum === worker.metrics.checksum,
      timestamp: new Date().toISOString(),
      methodology: 'Production AudioWorklet real-time Float32 capture versus the same-state direct renderSong and actual export-worker WAV; four bars, identical stepLimit, no resampling.',
      userAgent: navigator.userAgent,
      sampleRate,
      requestedSampleRate: 48000,
      bars,
      steps: bars * DSP.STEP_COUNT,
      renderQuantumFrames: 128,
      contextBaseLatency: context.baseLatency,
      contextOutputLatency: context.outputLatency,
      frames: offline.frames,
      durationSeconds: offline.frames / sampleRate,
      bodyFrames: Math.round(offline.bodyDuration * sampleRate),
      tailFrames: offline.tailFrames,
      tailTruncated: offline.tailTruncated,
      peak: offline.peak,
      rms: offline.rms,
      floatComparison,
      wavComparison,
      sha256: {
        realtimeLeftFloat32: await sha256(realtime.left.buffer),
        realtimeRightFloat32: await sha256(realtime.right.buffer),
        offlineLeftFloat32: await sha256(offline.left.buffer),
        offlineRightFloat32: await sha256(offline.right.buffer),
        realtimeWAV: await sha256(realtimeWav),
        workerWAV: await sha256(worker.wav),
        directOfflineWAV: await sha256(offlineWav)
      },
      workerMetrics: worker.metrics,
      computedWorkerFNV1a: checksum,
      state
    };
    setResult(result);
  } catch (error) {
    setResult({
      pass: false,
      timestamp: new Date().toISOString(),
      error: error && error.stack ? error.stack : String(error)
    });
  } finally {
    if (context && context.state !== 'closed') await context.close();
    runButton.disabled = false;
  }
}

runButton.addEventListener('click', run);
