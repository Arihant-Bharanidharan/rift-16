/*
 * RIFT/16 deterministic DSP core.
 * Runs unchanged in AudioWorklet, Web Worker, browser and Node.
 * No samples, soundfonts, third-party code or network access.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RiftDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const STEP_COUNT = 16;
  const TAIL_SILENCE_THRESHOLD = 0.0001;
  const TAIL_QUIET_SECONDS = 0.05;
  const MAX_TAIL_SECONDS = 30;
  const TAIL_FADE_SECONDS = 0.03;
  const TRACK_INFO = [
    { id: 'kick', name: 'Kick', role: 'Pitch-swept sine / transient', baseNote: 36, color: '#ff7a45' },
    { id: 'bass', name: 'Bass', role: 'PolyBLEP saw / resonant low-pass', baseNote: 36, color: '#61d7d1' },
    { id: 'glass', name: 'Glass', role: 'Two-operator FM / detuned pair', baseNote: 60, color: '#b69cff' },
    { id: 'noise', name: 'Noise', role: 'Seeded noise / metallic transient', baseNote: 78, color: '#d5e66b' }
  ];

  const PARAM_RANGES = [
    { tune: [-12, 12], decay: [0.08, 1.4], drive: [0, 1], click: [0, 1] },
    { cutoff: [80, 7000], resonance: [0.5, 12], decay: [0.06, 1.2], drive: [0, 1], sub: [0, 1] },
    { decay: [0.08, 2], modulation: [0, 8], detune: [0, 0.025], attack: [0.001, 0.2] },
    { cutoff: [1000, 16000], decay: [0.02, 0.8], tone: [0, 1], drive: [0, 1] }
  ];

  const DEFAULT_PARAMS = [
    { tune: 0, decay: 0.42, drive: 0.28, click: 0.35 },
    { cutoff: 920, resonance: 4.2, decay: 0.34, drive: 0.18, sub: 0.35 },
    { decay: 0.9, modulation: 2.4, detune: 0.006, attack: 0.008 },
    { cutoff: 6200, decay: 0.12, tone: 0.34, drive: 0.08 }
  ];

  const DEFAULT_LEVELS = [0.9, 0.62, 0.42, 0.36];
  const DEFAULT_PANS = [0, 0, -0.08, 0.12];
  const DEFAULT_SENDS = [0.04, 0.1, 0.32, 0.18];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  function makeStep(active, velocity, note) {
    return { active: !!active, velocity: velocity == null ? 0.82 : velocity, note: note || 0 };
  }

  function makeSteps(trackIndex) {
    const steps = Array.from({ length: STEP_COUNT }, () => makeStep(false));
    const activate = (index, velocity, note) => {
      steps[index] = makeStep(true, velocity, note || 0);
    };

    if (trackIndex === 0) {
      [[0, 1, 0], [4, 0.9, 0], [8, 0.96, 0], [12, 0.9, 0], [14, 0.48, -5]].forEach(v => activate(...v));
    } else if (trackIndex === 1) {
      [[0, 0.9, 0], [3, 0.66, 0], [6, 0.78, 3], [8, 0.88, 0], [10, 0.7, 7], [14, 0.74, 10]].forEach(v => activate(...v));
    } else if (trackIndex === 2) {
      [[2, 0.62, 12], [5, 0.44, 7], [7, 0.52, 3], [10, 0.68, 10], [13, 0.46, 15]].forEach(v => activate(...v));
    } else {
      for (let i = 2; i < 16; i += 4) activate(i, 0.7, 0);
      [1, 3, 5, 7, 9, 11, 13, 15].forEach((i, index) => activate(i, index % 2 ? 0.22 : 0.34, 0));
    }
    return steps;
  }

  function createDefaultState() {
    return {
      version: 1,
      name: 'Untitled signal',
      bpm: 124,
      swing: 0.12,
      master: 0.78,
      delay: { time: 0.75, feedback: 0.3, mix: 0.18 },
      tracks: TRACK_INFO.map((info, index) => ({
        id: info.id,
        level: DEFAULT_LEVELS[index],
        pan: DEFAULT_PANS[index],
        send: DEFAULT_SENDS[index],
        mute: false,
        solo: false,
        params: { ...DEFAULT_PARAMS[index] },
        steps: makeSteps(index)
      }))
    };
  }

  function normalizeState(input) {
    const output = createDefaultState();
    if (!input || typeof input !== 'object') return output;

    output.name = typeof input.name === 'string' ? input.name.slice(0, 80) : output.name;
    output.bpm = clamp(finite(input.bpm, output.bpm), 60, 180);
    output.swing = clamp(finite(input.swing, output.swing), 0, 0.45);
    output.master = clamp(finite(input.master, output.master), 0, 1);
    if (input.delay && typeof input.delay === 'object') {
      output.delay.time = clamp(finite(input.delay.time, output.delay.time), 0.25, 1.5);
      output.delay.feedback = clamp(finite(input.delay.feedback, output.delay.feedback), 0, 0.75);
      output.delay.mix = clamp(finite(input.delay.mix, output.delay.mix), 0, 0.65);
    }

    if (Array.isArray(input.tracks)) {
      output.tracks.forEach((track, trackIndex) => {
        const source = input.tracks[trackIndex];
        if (!source || typeof source !== 'object') return;
        track.level = clamp(finite(source.level, track.level), 0, 1);
        track.pan = clamp(finite(source.pan, track.pan), -1, 1);
        track.send = clamp(finite(source.send, track.send), 0, 1);
        track.mute = !!source.mute;
        track.solo = !!source.solo;
        const ranges = PARAM_RANGES[trackIndex];
        Object.keys(track.params).forEach(key => {
          if (source.params && Object.prototype.hasOwnProperty.call(source.params, key)) {
            track.params[key] = clamp(finite(source.params[key], track.params[key]), ranges[key][0], ranges[key][1]);
          }
        });
        if (Array.isArray(source.steps)) {
          track.steps = Array.from({ length: STEP_COUNT }, (_, stepIndex) => {
            const step = source.steps[stepIndex];
            if (!step || typeof step !== 'object') return makeStep(false);
            return {
              active: !!step.active,
              velocity: clamp(finite(step.velocity, 0.82), 0.05, 1),
              note: Math.round(clamp(finite(step.note, 0), -24, 24))
            };
          });
        }
      });
    }
    return output;
  }

  function euclidean(hits, steps, rotation) {
    const count = Math.max(1, Math.round(finite(steps, 16)));
    const onsets = Math.round(clamp(finite(hits, 0), 0, count));
    const offset = Math.round(finite(rotation, 0));
    const result = Array(count).fill(false);
    if (onsets === 0) return result;
    for (let i = 0; i < onsets; i++) {
      const index = Math.floor(i * count / onsets);
      result[(index + offset % count + count) % count] = true;
    }
    return result;
  }

  function polyBlep(phase, increment) {
    if (phase < increment) {
      const t = phase / increment;
      return t + t - t * t - 1;
    }
    if (phase > 1 - increment) {
      const t = (phase - 1) / increment;
      return t * t + t + t + 1;
    }
    return 0;
  }

  function nextRandom(voice) {
    let x = voice.random | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    voice.random = x | 0;
    return (x >>> 0) / 4294967296;
  }

  const VOICE_NUMERIC_FIELDS = [
    'age', 'note', 'velocity', 'duration', 'phase', 'phase2', 'modPhase',
    'low', 'band', 'noiseLow', 'random', 'pan'
  ];

  function voiceIsFinite(voice) {
    for (let i = 0; i < VOICE_NUMERIC_FIELDS.length; i++) {
      if (!Number.isFinite(voice[VOICE_NUMERIC_FIELDS[i]])) return false;
    }
    return true;
  }

  class Engine {
    constructor(state, sampleRate) {
      this.sampleRate = clamp(Math.round(finite(sampleRate, 44100)), 8000, 192000);
      this.state = normalizeState(state);
      this.trackAudibility = new Array(TRACK_INFO.length);
      this.anySolo = false;
      this.updateTrackAudibility();
      this.voices = TRACK_INFO.map(() => []);
      this.delayLeft = new Float32Array(this.sampleRate * 2);
      this.delayRight = new Float32Array(this.sampleRate * 2);
      this.delayIndex = 0;
      this.dc = { xl: 0, xr: 0, yl: 0, yr: 0 };
      this.mix = [0, 0, 0, 0];
      this.stepLimit = Infinity;
      this.resetTransport(true);
    }

    setState(state) {
      this.state = normalizeState(state);
      this.updateTrackAudibility();
    }

    updateTrackAudibility() {
      let anySolo = false;
      for (let i = 0; i < this.state.tracks.length; i++) {
        if (this.state.tracks[i].solo) anySolo = true;
      }
      this.anySolo = anySolo;
      for (let i = 0; i < this.state.tracks.length; i++) {
        const track = this.state.tracks[i];
        this.trackAudibility[i] = !track.mute && (!anySolo || track.solo);
      }
    }

    clearDelay() {
      this.delayLeft.fill(0);
      this.delayRight.fill(0);
      this.delayIndex = 0;
    }

    resetTransport(clearVoices) {
      this.playing = false;
      this.samplePosition = 0;
      this.nextStepSample = 0;
      this.stepIndex = 0;
      this.currentStep = -1;
      this.voiceSerial = 0;
      if (clearVoices) this.voices.forEach(voices => { voices.length = 0; });
    }

    start() {
      this.resetTransport(true);
      this.clearDelay();
      this.dc = { xl: 0, xr: 0, yl: 0, yr: 0 };
      this.playing = true;
    }

    pause() {
      this.playing = false;
    }

    resume() {
      if (this.stepIndex >= this.stepLimit) return;
      this.playing = true;
    }

    stop() {
      this.resetTransport(true);
      this.clearDelay();
      this.dc = { xl: 0, xr: 0, yl: 0, yr: 0 };
    }

    isTrackAudible(trackIndex) {
      return this.trackAudibility[trackIndex] === true;
    }

    stepDurationSamples(stepIndex) {
      const base = this.sampleRate * 60 / this.state.bpm / 4;
      return base * (stepIndex % 2 === 0 ? 1 + this.state.swing : 1 - this.state.swing);
    }

    triggerStep(stepIndex) {
      const localStep = stepIndex % STEP_COUNT;
      this.currentStep = localStep;
      const duration = this.stepDurationSamples(stepIndex) / this.sampleRate * 0.82;
      this.state.tracks.forEach((track, trackIndex) => {
        const step = track.steps[localStep];
        if (step.active) this.trigger(trackIndex, step.note, step.velocity, duration);
      });
    }

    trigger(trackIndex, note, velocity, duration) {
      if (trackIndex < 0 || trackIndex >= TRACK_INFO.length || !this.isTrackAudible(trackIndex)) return false;
      const voices = this.voices[trackIndex];
      const caps = [4, 6, 10, 6];
      if (voices.length >= caps[trackIndex]) voices.shift();
      const serial = ++this.voiceSerial;
      voices.push({
        age: 0,
        note: clamp(Math.round(finite(note, 0)), -24, 24),
        velocity: clamp(finite(velocity, 0.8), 0.01, 1),
        duration: clamp(finite(duration, 0.35), 0.025, 4),
        phase: 0,
        phase2: 0,
        modPhase: 0,
        low: 0,
        band: 0,
        noiseLow: 0,
        random: ((serial * 1597334677) ^ ((trackIndex + 1) * 1013904223)) | 0,
        pan: trackIndex === 2 ? (serial % 2 ? -0.28 : 0.28) : 0,
        dead: false
      });
      return true;
    }

    schedule() {
      let guard = 0;
      while (this.playing && this.samplePosition + 0.00001 >= this.nextStepSample && guard++ < 32) {
        if (this.stepIndex >= this.stepLimit) {
          this.playing = false;
          this.currentStep = -1;
          break;
        }
        const index = this.stepIndex++;
        this.triggerStep(index);
        this.nextStepSample += this.stepDurationSamples(index);
      }
    }

    renderVoice(voice, trackIndex) {
      if (!voiceIsFinite(voice)) {
        voice.dead = true;
        return 0;
      }
      const sr = this.sampleRate;
      const t = voice.age / sr;
      const params = this.state.tracks[trackIndex].params;
      const velocity = voice.velocity;
      let sample = 0;

      if (trackIndex === 0) {
        const frequency = midiToFreq(TRACK_INFO[0].baseNote + voice.note + params.tune);
        const swept = frequency + 135 * Math.exp(-t * 34);
        voice.phase += TAU * swept / sr;
        const envelope = Math.exp(-4.7 * t / params.decay);
        const body = Math.sin(voice.phase) * envelope;
        const click = (nextRandom(voice) * 2 - 1) * Math.exp(-t * 105) * params.click;
        sample = Math.tanh((body + click) * (1 + params.drive * 5)) * velocity * 0.92;
        voice.dead = t > params.decay * 1.8 + 0.08;
      } else if (trackIndex === 1) {
        const frequency = midiToFreq(TRACK_INFO[1].baseNote + voice.note);
        const increment = frequency / sr;
        voice.phase = (voice.phase + increment) % 1;
        voice.phase2 = (voice.phase2 + increment * 0.5) % 1;
        const saw = 2 * voice.phase - 1 - polyBlep(voice.phase, increment);
        const sub = Math.sin(voice.phase2 * TAU) * params.sub;
        const attack = Math.min(0.006, params.decay * 0.15);
        let envelope = t < attack ? t / attack : Math.exp(-4.5 * (t - attack) / params.decay);
        if (t > voice.duration) envelope *= Math.exp(-(t - voice.duration) * 32);
        const cutoff = clamp(params.cutoff * (0.55 + envelope * 1.45), 45, sr * 0.18);
        // Topology-preserving transform SVF: unlike the previous Euler SVF,
        // this discretization remains stable throughout the legal Q/cutoff range.
        const g = Math.tan(Math.PI * cutoff / sr);
        const k = 1 / params.resonance;
        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        const input = (saw + sub) * 0.7;
        const v3 = input - voice.low;
        const band = a1 * voice.band + a2 * v3;
        const low = voice.low + a2 * voice.band + a3 * v3;
        voice.band = 2 * band - voice.band;
        voice.low = 2 * low - voice.low;
        sample = Math.tanh(low * (1 + params.drive * 4)) * envelope * velocity * 0.82;
        voice.dead = t > Math.max(voice.duration + 0.15, params.decay * 1.8);
      } else if (trackIndex === 2) {
        const frequency = midiToFreq(TRACK_INFO[2].baseNote + voice.note);
        const modFrequency = frequency * 2.005;
        voice.phase += TAU * frequency / sr;
        voice.phase2 += TAU * frequency * (1 + params.detune) / sr;
        voice.modPhase += TAU * modFrequency / sr;
        const modEnvelope = Math.exp(-t * 4.5 / params.decay);
        const modulation = Math.sin(voice.modPhase) * params.modulation * modEnvelope;
        const carrier = Math.sin(voice.phase + modulation);
        const pair = Math.sin(voice.phase2 - modulation * 0.55);
        const attack = params.attack;
        const envelope = (t < attack ? t / attack : Math.exp(-4.7 * (t - attack) / params.decay));
        sample = (carrier + pair * 0.42) * envelope * velocity * 0.48;
        voice.dead = t > params.decay * 1.8 + attack + 0.05;
      } else {
        const white = nextRandom(voice) * 2 - 1;
        const alpha = 1 - Math.exp(-TAU * Math.min(params.cutoff, sr * 0.42) / sr);
        voice.noiseLow += alpha * (white - voice.noiseLow);
        const high = white - voice.noiseLow;
        const metalFrequency = 740 * Math.pow(2, voice.note / 12);
        const metal = (Math.sin(TAU * metalFrequency * t) >= 0 ? 1 : -1) * 0.55
          + Math.sin(TAU * metalFrequency * 1.487 * t) * 0.45;
        const envelope = Math.exp(-5.2 * t / params.decay);
        const source = high * (1 - params.tone * 0.7) + metal * params.tone;
        sample = Math.tanh(source * (1 + params.drive * 3)) * envelope * velocity * 0.52;
        voice.dead = t > params.decay * 1.8 + 0.04;
      }

      voice.age++;
      if (!Number.isFinite(sample) || !voiceIsFinite(voice)) {
        voice.dead = true;
        return 0;
      }
      return sample;
    }

    renderVoices() {
      let dryLeft = 0;
      let dryRight = 0;
      let sendLeft = 0;
      let sendRight = 0;

      for (let trackIndex = 0; trackIndex < this.voices.length; trackIndex++) {
        const voices = this.voices[trackIndex];
        const track = this.state.tracks[trackIndex];
        const audible = this.isTrackAudible(trackIndex);
        for (let i = voices.length - 1; i >= 0; i--) {
          const voice = voices[i];
          const value = this.renderVoice(voice, trackIndex);
          if (voice.dead) {
            voices.splice(i, 1);
            continue;
          }
          if (!audible) continue;
          const pan = clamp(track.pan + voice.pan, -1, 1);
          const leftGain = Math.cos((pan + 1) * Math.PI / 4);
          const rightGain = Math.sin((pan + 1) * Math.PI / 4);
          const left = value * leftGain * track.level;
          const right = value * rightGain * track.level;
          dryLeft += left;
          dryRight += right;
          sendLeft += left * track.send;
          sendRight += right * track.send;
        }
      }

      this.mix[0] = dryLeft;
      this.mix[1] = dryRight;
      this.mix[2] = sendLeft;
      this.mix[3] = sendRight;
    }

    readDelay(buffer, delaySamples) {
      const length = buffer.length;
      let position = this.delayIndex - delaySamples;
      while (position < 0) position += length;
      const first = Math.floor(position) % length;
      const second = (first + 1) % length;
      const fraction = position - Math.floor(position);
      return buffer[first] * (1 - fraction) + buffer[second] * fraction;
    }

    dcBlock(input, left) {
      const xKey = left ? 'xl' : 'xr';
      const yKey = left ? 'yl' : 'yr';
      const output = input - this.dc[xKey] + 0.995 * this.dc[yKey];
      this.dc[xKey] = input;
      this.dc[yKey] = output;
      return output;
    }

    renderBlock(left, right) {
      if (left.length !== right.length) throw new Error('Stereo block lengths must match.');
      const length = left.length;
      const delayConfig = this.state.delay;

      for (let i = 0; i < length; i++) {
        this.schedule();
        this.renderVoices();

        const delaySamples = clamp(delayConfig.time * 60 / this.state.bpm, 0.02, 1.8) * this.sampleRate;
        const delayedLeft = this.readDelay(this.delayLeft, delaySamples);
        const delayedRight = this.readDelay(this.delayRight, delaySamples);
        this.delayLeft[this.delayIndex] = this.mix[2] + delayedRight * delayConfig.feedback;
        this.delayRight[this.delayIndex] = this.mix[3] + delayedLeft * delayConfig.feedback;
        this.delayIndex = (this.delayIndex + 1) % this.delayLeft.length;

        const rawLeft = this.mix[0] + delayedRight * delayConfig.mix;
        const rawRight = this.mix[1] + delayedLeft * delayConfig.mix;
        const blockedLeft = this.dcBlock(rawLeft, true);
        const blockedRight = this.dcBlock(rawRight, false);
        const gain = this.state.master * 1.2;
        left[i] = Math.tanh(blockedLeft * gain);
        right[i] = Math.tanh(blockedRight * gain);
        if (this.playing) this.samplePosition++;
      }
    }
  }

  function renderSong(state, options) {
    const settings = options || {};
    const sampleRate = clamp(Math.round(finite(settings.sampleRate, 44100)), 8000, 192000);
    const bars = Math.round(clamp(finite(settings.bars, 4), 1, 32));
    const normalized = normalizeState(state);
    const engine = new Engine(normalized, sampleRate);
    engine.stepLimit = bars * STEP_COUNT;
    engine.start();

    const stepSeconds = 60 / normalized.bpm / 4;
    const bodyFrames = Math.ceil(bars * STEP_COUNT * stepSeconds * sampleRate) + 2;
    const maxTailFrames = Math.ceil(MAX_TAIL_SECONDS * sampleRate);
    const quietFramesRequired = Math.max(1, Math.ceil(TAIL_QUIET_SECONDS * sampleRate));
    const initialFrames = bodyFrames + Math.ceil(3.5 * sampleRate);
    const blockSize = 2048;
    let left = new Float32Array(initialFrames);
    let right = new Float32Array(initialFrames);

    const ensureCapacity = required => {
      if (required <= left.length) return;
      let capacity = left.length;
      const maximum = bodyFrames + maxTailFrames;
      while (capacity < required) capacity = Math.min(maximum, Math.max(required, capacity * 2));
      const nextLeft = new Float32Array(capacity);
      const nextRight = new Float32Array(capacity);
      nextLeft.set(left);
      nextRight.set(right);
      left = nextLeft;
      right = nextRight;
    };
    const hasActiveVoices = () => {
      for (let i = 0; i < engine.voices.length; i++) {
        if (engine.voices[i].length !== 0) return true;
      }
      return false;
    };
    const delayIsQuiet = () => {
      for (let i = 0; i < engine.delayLeft.length; i++) {
        if (!(Math.abs(engine.delayLeft[i]) <= TAIL_SILENCE_THRESHOLD)
          || !(Math.abs(engine.delayRight[i]) <= TAIL_SILENCE_THRESHOLD)) return false;
      }
      return true;
    };
    const reportProgress = frames => {
      if (typeof settings.onProgress === 'function') {
        settings.onProgress(Math.min(0.995, frames / initialFrames));
      }
    };

    let offset = 0;
    while (offset < bodyFrames) {
      const frames = Math.min(blockSize, bodyFrames - offset);
      engine.renderBlock(left.subarray(offset, offset + frames), right.subarray(offset, offset + frames));
      offset += frames;
      reportProgress(offset);
    }
    engine.pause();

    let tailFrames = 0;
    let quietFrames = 0;
    let tailComplete = false;
    while (tailFrames < maxTailFrames && !tailComplete) {
      offset = bodyFrames + tailFrames;
      const frames = Math.min(blockSize, maxTailFrames - tailFrames);
      const voicesActiveAtBlockStart = hasActiveVoices();
      ensureCapacity(offset + frames);
      engine.renderBlock(left.subarray(offset, offset + frames), right.subarray(offset, offset + frames));
      const voicesActiveDuringBlock = voicesActiveAtBlockStart || hasActiveVoices();

      let usedFrames = frames;
      for (let i = 0; i < frames; i++) {
        const l = left[offset + i];
        const r = right[offset + i];
        const outputQuiet = Number.isFinite(l) && Number.isFinite(r)
          && Math.abs(l) <= TAIL_SILENCE_THRESHOLD && Math.abs(r) <= TAIL_SILENCE_THRESHOLD;
        if (!voicesActiveDuringBlock && outputQuiet) quietFrames++;
        else quietFrames = 0;

        if (quietFrames >= quietFramesRequired) {
          if (delayIsQuiet()) {
            usedFrames = i + 1;
            tailComplete = true;
            break;
          }
          // Avoid repeatedly scanning the delay lines while a later echo is pending.
          quietFrames = 0;
        }
      }
      tailFrames += usedFrames;
      reportProgress(bodyFrames + tailFrames);
    }

    const totalFrames = bodyFrames + tailFrames;
    const tailTruncated = !tailComplete;
    let tailFadeFrames = 0;
    if (tailTruncated) {
      tailFadeFrames = Math.min(tailFrames, Math.max(1, Math.ceil(TAIL_FADE_SECONDS * sampleRate)));
      const fadeStart = totalFrames - tailFadeFrames;
      for (let i = 0; i < tailFadeFrames; i++) {
        const gain = tailFadeFrames === 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * i / (tailFadeFrames - 1)));
        left[fadeStart + i] *= gain;
        right[fadeStart + i] *= gain;
      }
    }
    if (left.length !== totalFrames) {
      left = left.slice(0, totalFrames);
      right = right.slice(0, totalFrames);
    }
    if (typeof settings.onProgress === 'function') settings.onProgress(1);

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < totalFrames; i++) {
      const l = left[i];
      const r = right[i];
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSquares += l * l + r * r;
    }

    return {
      left,
      right,
      sampleRate,
      frames: totalFrames,
      duration: totalFrames / sampleRate,
      bodyDuration: bodyFrames / sampleRate,
      tailFrames,
      tailDuration: tailFrames / sampleRate,
      tailTruncated,
      tailFadeFrames,
      tailFadeDuration: tailFadeFrames / sampleRate,
      tailThreshold: TAIL_SILENCE_THRESHOLD,
      tailQuietDuration: TAIL_QUIET_SECONDS,
      peak,
      rms: Math.sqrt(sumSquares / (totalFrames * 2))
    };
  }

  function encodeWAV(left, right, sampleRate) {
    if (left.length !== right.length) throw new Error('Stereo channel lengths must match.');
    const frames = left.length;
    const dataSize = frames * 4;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < frames; i++) {
      const l = Math.round(clamp(left[i], -1, 1) * 32767);
      const r = Math.round(clamp(right[i], -1, 1) * 32767);
      view.setInt16(offset, l, true);
      view.setInt16(offset + 2, r, true);
      offset += 4;
    }
    return buffer;
  }

  return {
    TAU,
    STEP_COUNT,
    TRACK_INFO,
    PARAM_RANGES,
    DEFAULT_PARAMS,
    Engine,
    clamp,
    midiToFreq,
    createDefaultState,
    normalizeState,
    euclidean,
    renderSong,
    encodeWAV
  };
});
