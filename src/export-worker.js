'use strict';
importScripts('./dsp-core.cjs');

self.onmessage = event => {
  const message = event.data || {};
  if (message.type !== 'render') return;

  try {
    const result = RiftDSP.renderSong(message.state, {
      sampleRate: message.sampleRate,
      bars: message.bars,
      onProgress: progress => self.postMessage({ type: 'progress', progress })
    });
    const wav = RiftDSP.encodeWAV(result.left, result.right, result.sampleRate);

    // FNV-1a gives users a deterministic render fingerprint without async crypto.
    const bytes = new Uint8Array(wav);
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }

    self.postMessage({
      type: 'complete',
      wav,
      metrics: {
        duration: result.duration,
        bodyDuration: result.bodyDuration,
        frames: result.frames,
        sampleRate: result.sampleRate,
        peak: result.peak,
        rms: result.rms,
        checksum: (hash >>> 0).toString(16).padStart(8, '0').toUpperCase()
      }
    }, [wav]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
  }
};
