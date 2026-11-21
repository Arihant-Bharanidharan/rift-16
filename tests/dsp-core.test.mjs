import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DSP = require('../src/dsp-core.cjs');

const VOICE_NUMERIC_FIELDS = [
  'age', 'note', 'velocity', 'duration', 'phase', 'phase2', 'modPhase',
  'low', 'band', 'noiseLow', 'random', 'pan'
];

function isolatedTrackState(trackIndex) {
  const state = DSP.createDefaultState();
  state.master = 1;
  state.delay = { time: 0.25, feedback: 0, mix: 0 };
  state.tracks.forEach((track, index) => {
    track.steps.forEach(step => { step.active = false; });
    track.mute = index !== trackIndex;
    track.solo = false;
    track.level = index === trackIndex ? 1 : 0;
    track.send = 0;
    track.pan = 0;
  });
  return state;
}

function assertFiniteVoice(voice, context = 'voice') {
  for (const field of VOICE_NUMERIC_FIELDS) {
    assert.ok(Number.isFinite(voice[field]), `${context}: ${field} must be finite`);
  }
}

function assertFiniteStereo(left, right, context = 'render') {
  assert.equal(left.length, right.length, `${context}: stereo lengths`);
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) {
      assert.fail(`${context}: non-finite sample at frame ${i}`);
    }
  }
}

function peakFrom(left, right, start = 0, end = left.length) {
  let peak = 0;
  for (let i = start; i < end; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  return peak;
}

test('the public DSP API and track metadata remain available', () => {
  for (const name of [
    'Engine', 'renderSong', 'encodeWAV', 'createDefaultState',
    'normalizeState', 'euclidean'
  ]) {
    assert.equal(typeof DSP[name], 'function', name);
  }
  assert.equal(DSP.STEP_COUNT, 16);
  assert.deepEqual(DSP.TRACK_INFO.map(track => track.id), ['kick', 'bass', 'glass', 'noise']);
  assert.equal(DSP.PARAM_RANGES.length, DSP.TRACK_INFO.length);

  const engine = new DSP.Engine(DSP.createDefaultState(), 44100);
  assert.equal(engine.sampleRate, 44100);
  assert.equal(engine.voices.length, 4);
  assert.equal(engine.stepLimit, Infinity);
});

test('default and normalized states are independent, complete four-track states', () => {
  const defaults = DSP.createDefaultState();
  const normalized = DSP.normalizeState(defaults);
  assert.deepEqual(normalized, defaults);
  assert.notStrictEqual(normalized, defaults);
  assert.notStrictEqual(normalized.tracks, defaults.tracks);
  assert.notStrictEqual(normalized.delay, defaults.delay);

  for (let i = 0; i < normalized.tracks.length; i++) {
    assert.notStrictEqual(normalized.tracks[i], defaults.tracks[i]);
    assert.notStrictEqual(normalized.tracks[i].params, defaults.tracks[i].params);
    assert.notStrictEqual(normalized.tracks[i].steps, defaults.tracks[i].steps);
    assert.equal(normalized.tracks[i].steps.length, 16);
  }

  normalized.tracks[0].params.decay = 1.4;
  normalized.tracks[0].steps[0].active = false;
  normalized.delay.feedback = 0;
  assert.notEqual(defaults.tracks[0].params.decay, normalized.tracks[0].params.decay);
  assert.equal(defaults.tracks[0].steps[0].active, true);
  assert.notEqual(defaults.delay.feedback, normalized.delay.feedback);
  assert.deepEqual(DSP.normalizeState(null), defaults);
});

test('normalization clamps every parameter, transport value, step and mixer control', () => {
  for (const extreme of ['low', 'high']) {
    const sign = extreme === 'low' ? -1 : 1;
    const input = DSP.createDefaultState();
    input.name = 'x'.repeat(100);
    input.bpm = sign * 100000;
    input.swing = sign * 100000;
    input.master = sign * 100000;
    input.delay = { time: sign * 100000, feedback: sign * 100000, mix: sign * 100000 };
    input.tracks.forEach((track, trackIndex) => {
      track.level = sign * 100000;
      track.pan = sign * 100000;
      track.send = sign * 100000;
      track.mute = extreme === 'high';
      track.solo = extreme === 'high';
      for (const key of Object.keys(track.params)) track.params[key] = sign * 100000;
      track.steps = Array.from({ length: 20 }, () => ({
        active: true,
        velocity: sign * 100000,
        note: sign * 100000
      }));
      for (const [key, range] of Object.entries(DSP.PARAM_RANGES[trackIndex])) {
        assert.ok(Object.hasOwn(track.params, key), `missing parameter ${key}`);
        void range;
      }
    });

    const output = DSP.normalizeState(input);
    assert.equal(output.name.length, 80);
    assert.equal(output.bpm, extreme === 'low' ? 60 : 180);
    assert.equal(output.swing, extreme === 'low' ? 0 : 0.45);
    assert.equal(output.master, extreme === 'low' ? 0 : 1);
    assert.deepEqual(output.delay, extreme === 'low'
      ? { time: 0.25, feedback: 0, mix: 0 }
      : { time: 1.5, feedback: 0.75, mix: 0.65 });

    output.tracks.forEach((track, trackIndex) => {
      assert.equal(track.level, extreme === 'low' ? 0 : 1);
      assert.equal(track.pan, extreme === 'low' ? -1 : 1);
      assert.equal(track.send, extreme === 'low' ? 0 : 1);
      assert.equal(track.mute, extreme === 'high');
      assert.equal(track.solo, extreme === 'high');
      assert.equal(track.steps.length, 16);
      for (const [key, range] of Object.entries(DSP.PARAM_RANGES[trackIndex])) {
        assert.equal(track.params[key], range[extreme === 'low' ? 0 : 1], `${track.id}.${key}`);
      }
      for (const step of track.steps) {
        assert.equal(step.active, true);
        assert.equal(step.velocity, extreme === 'low' ? 0.05 : 1);
        assert.equal(step.note, extreme === 'low' ? -24 : 24);
      }
    });
  }
});

test('normalization falls back safely for malformed and non-finite values', () => {
  const defaults = DSP.createDefaultState();
  const input = DSP.createDefaultState();
  input.name = 42;
  input.bpm = Number.NaN;
  input.swing = Number.POSITIVE_INFINITY;
  input.master = 'not a number';
  input.delay = { time: Number.NaN, feedback: Number.POSITIVE_INFINITY, mix: undefined };
  input.tracks[0].level = Number.NaN;
  input.tracks[0].pan = Number.NEGATIVE_INFINITY;
  input.tracks[0].send = {};
  for (const key of Object.keys(input.tracks[0].params)) input.tracks[0].params[key] = Number.NaN;
  input.tracks[0].steps = [
    { active: 1, velocity: Number.NaN, note: Number.POSITIVE_INFINITY },
    { active: true, velocity: '0.5', note: 5.6 },
    null
  ];

  const output = DSP.normalizeState(input);
  assert.equal(output.name, defaults.name);
  assert.equal(output.bpm, defaults.bpm);
  assert.equal(output.swing, defaults.swing);
  assert.equal(output.master, defaults.master);
  assert.deepEqual(output.delay, defaults.delay);
  assert.equal(output.tracks[0].level, defaults.tracks[0].level);
  assert.equal(output.tracks[0].pan, defaults.tracks[0].pan);
  assert.equal(output.tracks[0].send, defaults.tracks[0].send);
  assert.deepEqual(output.tracks[0].params, defaults.tracks[0].params);
  assert.deepEqual(output.tracks[0].steps[0], { active: true, velocity: 0.82, note: 0 });
  assert.deepEqual(output.tracks[0].steps[1], { active: true, velocity: 0.5, note: 6 });
  assert.deepEqual(output.tracks[0].steps[2], { active: false, velocity: 0.82, note: 0 });
  assert.equal(output.tracks[0].steps.length, 16);
});

test('Euclidean patterns preserve hit count under positive, negative and wrapped rotation', () => {
  const base = DSP.euclidean(5, 16, 0);
  assert.equal(base.filter(Boolean).length, 5);
  assert.deepEqual(DSP.euclidean(4, 16, 0).map(Number), [
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0
  ]);

  for (const rotation of [-33, -16, -1, 0, 1, 16, 33]) {
    const rotated = DSP.euclidean(5, 16, rotation);
    assert.equal(rotated.filter(Boolean).length, 5);
    for (let i = 0; i < base.length; i++) {
      assert.equal(rotated[(i + rotation % 16 + 16) % 16], base[i], `rotation ${rotation}`);
    }
  }

  assert.deepEqual(DSP.euclidean(0, 8, 3), Array(8).fill(false));
  assert.deepEqual(DSP.euclidean(20, 4, -1), Array(4).fill(true));
  assert.equal(DSP.euclidean(1, 0, 0).length, 1);
  assert.equal(DSP.euclidean(Number.NaN, Number.NaN, Number.NaN).filter(Boolean).length, 0);
});

test('transport timing applies alternating swing without changing the bar length', () => {
  const state = DSP.createDefaultState();
  state.bpm = 120;
  state.swing = 0.45;
  const engine = new DSP.Engine(state, 48000);
  assert.ok(Math.abs(engine.stepDurationSamples(0) - 8700) < 1e-9);
  assert.ok(Math.abs(engine.stepDurationSamples(1) - 3300) < 1e-9);
  assert.ok(Math.abs(engine.stepDurationSamples(2) - 8700) < 1e-9);
  assert.ok(Math.abs(engine.stepDurationSamples(0) + engine.stepDurationSamples(1) - 12000) < 1e-9);

  state.swing = 0;
  engine.setState(state);
  assert.equal(engine.stepDurationSamples(0), 6000);
  assert.equal(engine.stepDurationSamples(1), 6000);

  state.swing = 0.45;
  engine.setState(state);
  const events = [];
  engine.triggerStep = index => {
    events.push({ index, samplePosition: engine.samplePosition });
    engine.currentStep = index % 16;
  };
  engine.stepLimit = 4;
  engine.start();
  const left = new Float32Array(24001);
  const right = new Float32Array(left.length);
  engine.renderBlock(left, right);

  assert.deepEqual(events, [
    { index: 0, samplePosition: 0 },
    { index: 1, samplePosition: 8700 },
    { index: 2, samplePosition: 12000 },
    { index: 3, samplePosition: 20700 }
  ]);
  assert.equal(engine.stepIndex, 4);
  assert.equal(engine.playing, false);
  assert.equal(engine.currentStep, -1);
});

test('setState refreshes cached mute/solo audibility and muted voices are not mixed', () => {
  const engine = new DSP.Engine(DSP.createDefaultState(), 8000);
  assert.equal(engine.anySolo, false);
  assert.deepEqual(engine.trackAudibility, [true, true, true, true]);

  const muted = DSP.createDefaultState();
  muted.tracks[1].mute = true;
  engine.setState(muted);
  assert.deepEqual(engine.trackAudibility, [true, false, true, true]);
  assert.equal(engine.anySolo, false);

  const soloed = DSP.createDefaultState();
  soloed.tracks[2].solo = true;
  soloed.tracks[3].solo = true;
  soloed.tracks[3].mute = true;
  engine.setState(soloed);
  assert.equal(engine.anySolo, true);
  assert.deepEqual(engine.trackAudibility, [false, false, true, false]);
  assert.equal(engine.isTrackAudible(2), true);
  assert.equal(engine.isTrackAudible(3), false);
  assert.equal(engine.trigger(0, 0, 1, 0.2), false);
  assert.equal(engine.trigger(2, 0, 1, 0.2), true);

  const state = isolatedTrackState(0);
  const mutedEngine = new DSP.Engine(state, 8000);
  assert.equal(mutedEngine.trigger(0, 0, 1, 0.35), true);
  state.tracks[0].mute = true;
  mutedEngine.setState(state);
  const left = new Float32Array(64);
  const right = new Float32Array(64);
  mutedEngine.renderBlock(left, right);
  assert.equal(mutedEngine.trigger(0, 0, 1, 0.35), false);
  assertFiniteStereo(left, right);
  assert.equal(peakFrom(left, right), 0);
});

test('voice stealing enforces each track cap and retains the newest voices', () => {
  const caps = [4, 6, 10, 6];
  for (let trackIndex = 0; trackIndex < caps.length; trackIndex++) {
    const engine = new DSP.Engine(isolatedTrackState(trackIndex), 16000);
    const triggered = [];
    for (let i = 0; i < caps[trackIndex] + 3; i++) {
      assert.equal(engine.trigger(trackIndex, i % 25 - 12, 0.8, 0.35), true);
      triggered.push(engine.voices[trackIndex].at(-1));
    }
    assert.equal(engine.voices[trackIndex].length, caps[trackIndex]);
    assert.deepEqual(engine.voices[trackIndex], triggered.slice(-caps[trackIndex]));
    assert.equal(engine.trigger(-1, 0, 1, 0.2), false);
    assert.equal(engine.trigger(4, 0, 1, 0.2), false);
  }
});

test('bass SVF stays finite, bounded and energetic at legal extremes and sample rates', () => {
  const sampleRates = [8000, 11025, 16000, 22050, 44100, 48000, 96000, 192000];
  const notes = [-24, -12, 0, 12, 24];
  const presets = [
    { cutoff: 80, resonance: 0.5, decay: 0.06, drive: 0, sub: 0 },
    { cutoff: 7000, resonance: 12, decay: 1.2, drive: 1, sub: 1 },
    { cutoff: 80, resonance: 12, decay: 1.2, drive: 1, sub: 1 },
    { cutoff: 7000, resonance: 0.5, decay: 0.06, drive: 0, sub: 0 },
    { cutoff: 80, resonance: 12, decay: 0.06, drive: 1, sub: 0 },
    { cutoff: 7000, resonance: 0.5, decay: 1.2, drive: 0, sub: 1 }
  ];

  for (const sampleRate of sampleRates) {
    const state = isolatedTrackState(1);
    const engine = new DSP.Engine(state, sampleRate);
    for (const preset of presets) {
      state.tracks[1].params = { ...preset };
      engine.setState(state);
      for (const note of notes) {
        engine.voices[1].length = 0;
        assert.equal(engine.trigger(1, note, 1, 4), true);
        const voice = engine.voices[1][0];
        const frames = Math.ceil(sampleRate * 0.12);
        let energy = 0;
        let peak = 0;
        let largestState = 0;
        for (let i = 0; i < frames; i++) {
          const sample = engine.renderVoice(voice, 1);
          const context = `sr=${sampleRate}, note=${note}, preset=${JSON.stringify(preset)}, frame=${i}`;
          if (!Number.isFinite(sample)) assert.fail(`${context}: non-finite output`);
          for (const field of VOICE_NUMERIC_FIELDS) {
            if (!Number.isFinite(voice[field])) assert.fail(`${context}: non-finite ${field}`);
          }
          largestState = Math.max(largestState, Math.abs(voice.low), Math.abs(voice.band));
          if (largestState > 1e6) assert.fail(`${context}: unstable SVF state ${largestState}`);
          energy += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        assert.ok(peak > 1e-5, `sr=${sampleRate}, note=${note}: bass must remain audible`);
        assert.ok(energy > 1e-9, `sr=${sampleRate}, note=${note}: bass must retain energy`);
      }
    }
  }
});

test('non-finite or diverging voice state is killed before it reaches the mix', () => {
  const injections = [
    { trackIndex: 0, field: 'phase', value: Number.POSITIVE_INFINITY },
    { trackIndex: 1, field: 'low', value: Number.NaN },
    // This value passes the pre-render finite check but diverges while calculating frequency/phase.
    { trackIndex: 1, field: 'note', value: Number.MAX_VALUE },
    { trackIndex: 2, field: 'phase2', value: Number.NEGATIVE_INFINITY },
    { trackIndex: 3, field: 'noiseLow', value: Number.NaN }
  ];

  for (const { trackIndex, field, value } of injections) {
    const state = isolatedTrackState(trackIndex);
    state.tracks[trackIndex].send = 1;
    state.delay = { time: 1.5, feedback: 0.75, mix: 0.65 };
    const engine = new DSP.Engine(state, 44100);
    assert.equal(engine.trigger(trackIndex, 0, 1, 0.35), true);
    engine.voices[trackIndex][0][field] = value;
    const left = new Float32Array(32);
    const right = new Float32Array(32);
    engine.renderBlock(left, right);
    assert.equal(engine.voices[trackIndex].length, 0, `${field} voice must be removed`);
    assertFiniteStereo(left, right, `${field} injection`);
    assert.equal(peakFrom(left, right), 0, `${field} must not leak into output`);
  }
});

test('all four voice types synthesize finite, nonzero audio at parameter and note extremes', () => {
  const sampleRates = [8000, 44100, 192000];
  const notes = [-24, 0, 24];
  for (let trackIndex = 0; trackIndex < 4; trackIndex++) {
    for (const extreme of [0, 1]) {
      for (const sampleRate of sampleRates) {
        const state = isolatedTrackState(trackIndex);
        state.tracks[trackIndex].send = 0.5;
        state.delay = { time: 0.75, feedback: 0.5, mix: 0.3 };
        for (const [key, range] of Object.entries(DSP.PARAM_RANGES[trackIndex])) {
          state.tracks[trackIndex].params[key] = range[extreme];
        }
        const engine = new DSP.Engine(state, sampleRate);
        for (const note of notes) {
          engine.voices[trackIndex].length = 0;
          engine.clearDelay();
          engine.dc = { xl: 0, xr: 0, yl: 0, yr: 0 };
          assert.equal(engine.trigger(trackIndex, note, 0.9, 0.35), true);
          const totalFrames = Math.ceil(sampleRate * 0.12);
          const left = new Float32Array(totalFrames);
          const right = new Float32Array(totalFrames);
          let offset = 0;
          let blockIndex = 0;
          const blockSizes = [1, 31, 512, 77, 2048];
          while (offset < totalFrames) {
            const frames = Math.min(blockSizes[blockIndex++ % blockSizes.length], totalFrames - offset);
            engine.renderBlock(
              left.subarray(offset, offset + frames),
              right.subarray(offset, offset + frames)
            );
            for (const voices of engine.voices) {
              for (const voice of voices) {
                assertFiniteVoice(voice, `track=${trackIndex}, sr=${sampleRate}, note=${note}`);
              }
            }
            offset += frames;
          }
          const context = `track=${trackIndex}, extreme=${extreme}, sr=${sampleRate}, note=${note}`;
          assertFiniteStereo(left, right, context);
          assert.ok(peakFrom(left, right) > 1e-7, `${context}: expected nonzero synthesis`);
        }
      }
    }
  }
});

test('Engine rendering is bit-identical across stereo block partitions', () => {
  const state = DSP.createDefaultState();
  state.bpm = 137;
  state.swing = 0.45;
  state.delay = { time: 1.5, feedback: 0.65, mix: 0.65 };
  const frames = 60000;
  const whole = new DSP.Engine(state, 16000);
  const partitioned = new DSP.Engine(state, 16000);
  whole.stepLimit = 32;
  partitioned.stepLimit = 32;
  whole.start();
  partitioned.start();

  const wholeLeft = new Float32Array(frames);
  const wholeRight = new Float32Array(frames);
  const partLeft = new Float32Array(frames);
  const partRight = new Float32Array(frames);
  whole.renderBlock(wholeLeft, wholeRight);

  const sizes = [1, 17, 2048, 3, 511, 4096, 127, 64];
  let offset = 0;
  let index = 0;
  while (offset < frames) {
    const length = Math.min(sizes[index++ % sizes.length], frames - offset);
    partitioned.renderBlock(
      partLeft.subarray(offset, offset + length),
      partRight.subarray(offset, offset + length)
    );
    offset += length;
  }

  assertFiniteStereo(wholeLeft, wholeRight, 'whole-block render');
  assert.deepStrictEqual(partLeft, wholeLeft);
  assert.deepStrictEqual(partRight, wholeRight);
  assert.deepStrictEqual(partitioned.voices, whole.voices);
  assert.deepStrictEqual(partitioned.delayLeft, whole.delayLeft);
  assert.deepStrictEqual(partitioned.delayRight, whole.delayRight);
  assert.deepStrictEqual(partitioned.dc, whole.dc);
  assert.equal(partitioned.delayIndex, whole.delayIndex);
  assert.equal(partitioned.samplePosition, whole.samplePosition);
  assert.equal(partitioned.stepIndex, whole.stepIndex);
});

test('offline song rendering is deterministic and reports monotonic complete progress', () => {
  const state = DSP.createDefaultState();
  const progress = [];
  const options = {
    sampleRate: 16000,
    bars: 2,
    onProgress: value => progress.push(value)
  };
  const first = DSP.renderSong(state, options);
  const second = DSP.renderSong(state, { sampleRate: 16000, bars: 2 });
  assert.deepStrictEqual(second, first);
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 1);
  for (let i = 0; i < progress.length; i++) {
    assert.ok(Number.isFinite(progress[i]) && progress[i] >= 0 && progress[i] <= 1);
    if (i > 0) assert.ok(progress[i] >= progress[i - 1], 'progress must be monotonic');
  }
  assertFiniteStereo(first.left, first.right, 'deterministic offline render');
  assert.ok(first.peak > 0 && first.rms > 0);
});

test('ordinary exports stop after a detected quiet interval without a cap fade', () => {
  const sampleRate = 16000;
  const bars = 4;
  const state = DSP.createDefaultState();
  const result = DSP.renderSong(state, { sampleRate, bars });
  const expectedBodyFrames = Math.ceil(bars * 16 * (60 / state.bpm / 4) * sampleRate) + 2;

  assertFiniteStereo(result.left, result.right, 'ordinary export');
  assert.equal(result.bodyDuration, expectedBodyFrames / sampleRate);
  assert.equal(result.tailTruncated, false);
  assert.equal(result.tailFadeFrames, 0);
  assert.equal(result.tailFadeDuration, 0);
  assert.equal(result.tailThreshold, 0.0001);
  assert.equal(result.tailQuietDuration, 0.05);
  assert.equal(result.frames, expectedBodyFrames + result.tailFrames);
  assert.equal(result.duration, result.frames / sampleRate);
  assert.equal(result.tailDuration, result.tailFrames / sampleRate);
  assert.ok(result.tailFrames > 0);
  assert.ok(result.tailDuration < 6, `ordinary tail was unexpectedly long: ${result.tailDuration}s`);
  assert.ok(result.duration < result.bodyDuration + 6);

  const quietFrames = Math.ceil(result.tailQuietDuration * sampleRate);
  for (let i = result.frames - quietFrames; i < result.frames; i++) {
    assert.ok(Math.abs(result.left[i]) <= result.tailThreshold, `left tail frame ${i} is not quiet`);
    assert.ok(Math.abs(result.right[i]) <= result.tailThreshold, `right tail frame ${i} is not quiet`);
  }
});

test('late echoes survive the old fixed tail and the 30 second cap gets a cosine endpoint fade', () => {
  const sampleRate = 8000;
  const bars = 1;
  const state = isolatedTrackState(2);
  state.bpm = 60;
  state.swing = 0.45;
  state.master = 0.78;
  state.delay = { time: 1.5, feedback: 0.75, mix: 0.65 };
  state.tracks[2].level = 1;
  state.tracks[2].send = 1;
  state.tracks[2].params.decay = 2;
  state.tracks[2].params.attack = 0.2;
  state.tracks[2].steps[15] = { active: true, velocity: 1, note: 0 };

  const result = DSP.renderSong(state, { sampleRate, bars });
  const bodyFrames = Math.ceil(bars * 16 * (60 / state.bpm / 4) * sampleRate) + 2;
  const oldFixedEnd = bodyFrames + Math.ceil(3.5 * sampleRate);
  const retainedPeak = peakFrom(result.left, result.right, oldFixedEnd);

  assertFiniteStereo(result.left, result.right, 'long-tail regression');
  assert.equal(result.bodyDuration, bodyFrames / sampleRate);
  assert.ok(oldFixedEnd < result.frames, 'render must extend beyond the former fixed endpoint');
  assert.ok(retainedPeak > 0.001, `late tail audio was lost (peak ${retainedPeak})`);
  assert.equal(result.tailTruncated, true);
  assert.equal(result.tailFrames, Math.ceil(30 * sampleRate));
  assert.equal(result.tailDuration, 30);
  assert.equal(result.tailFadeFrames, Math.ceil(0.03 * sampleRate));
  assert.equal(result.tailFadeDuration, result.tailFadeFrames / sampleRate);
  assert.equal(result.frames, bodyFrames + result.tailFrames);
  assert.equal(result.left.at(-1), 0);
  assert.equal(result.right.at(-1), 0);
});

test('WAV encoding writes a canonical 16-bit stereo PCM header and clipped samples', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const right = new Float32Array([1, -1, 0.25, -0.25, 0, 0, 0]);
  const sampleRate = 44100;
  const wav = DSP.encodeWAV(left, right, sampleRate);
  assert.ok(wav instanceof ArrayBuffer);
  assert.equal(wav.byteLength, 44 + left.length * 4);
  const view = new DataView(wav);
  const text = (offset, length) => String.fromCharCode(...new Uint8Array(wav, offset, length));

  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(28, true), sampleRate * 4);
  assert.equal(view.getUint16(32, true), 4);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), left.length * 4);

  const expectedLeft = [0, 16384, -16383, 32767, -32767, 32767, -32767];
  const expectedRight = [32767, -32767, 8192, -8192, 0, 0, 0];
  for (let i = 0; i < left.length; i++) {
    assert.equal(view.getInt16(44 + i * 4, true), expectedLeft[i], `left sample ${i}`);
    assert.equal(view.getInt16(46 + i * 4, true), expectedRight[i], `right sample ${i}`);
  }

  assert.equal(DSP.encodeWAV(new Float32Array(0), new Float32Array(0), 8000).byteLength, 44);
  assert.throws(() => DSP.encodeWAV(new Float32Array(1), new Float32Array(0), 44100), /lengths must match/);
});
