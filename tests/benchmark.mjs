import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, arch } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DSP = require('../src/dsp-core.cjs');
const SAMPLE_RATE = 48000;
const QUANTUM_FRAMES = 128;
const RUN_SECONDS = 1;
const BLOCKS = SAMPLE_RATE * RUN_SECONDS / QUANTUM_FRAMES;
const REPETITIONS = 7;
const WARMUPS = 2;
const VOICE_COUNTS = [16, 32, 64];
const ROOT = fileURLToPath(new URL('../', import.meta.url));

if (!Number.isInteger(BLOCKS)) throw new Error('The benchmark must use an integer number of audio quanta.');

function benchmarkState() {
  const state = DSP.createDefaultState();
  state.name = 'Exact-concurrency synthesis benchmark';
  state.master = 1;
  state.delay = { time: 0.25, feedback: 0, mix: 0 };
  state.tracks.forEach((track, trackIndex) => {
    track.level = 0.25;
    track.pan = 0;
    track.send = 0;
    track.mute = false;
    track.solo = false;
    track.params.decay = DSP.PARAM_RANGES[trackIndex].decay[1];
    track.steps.forEach(step => { step.active = false; });
  });
  return state;
}

function seedExactVoices(voiceCount) {
  const engine = new DSP.Engine(benchmarkState(), SAMPLE_RATE);
  const buckets = DSP.TRACK_INFO.map(() => []);
  for (let index = 0; index < voiceCount; index++) {
    const trackIndex = index % DSP.TRACK_INFO.length;
    const note = index % 25 - 12;
    if (!engine.trigger(trackIndex, note, 0.8, 4)) throw new Error('Benchmark voice seeding failed.');
    // Harvest each production-created voice before the next trigger so the normal
    // per-track stealing cap cannot reduce this explicit stress-test concurrency.
    buckets[trackIndex].push(engine.voices[trackIndex].pop());
  }
  engine.voices = buckets;
  return engine;
}

function activeVoices(engine) {
  return engine.voices.reduce((total, voices) => total + voices.length, 0);
}

function measure(voiceCount) {
  const engine = seedExactVoices(voiceCount);
  const left = new Float32Array(QUANTUM_FRAMES);
  const right = new Float32Array(QUANTUM_FRAMES);
  let checksum = 0;
  const start = performance.now();
  for (let block = 0; block < BLOCKS; block++) {
    engine.renderBlock(left, right);
    checksum += left[0] + right[0];
  }
  const elapsedMs = performance.now() - start;
  const finalVoiceCount = activeVoices(engine);
  if (finalVoiceCount !== voiceCount) {
    throw new Error(`${voiceCount}-voice run ended with ${finalVoiceCount} active voices.`);
  }
  if (!Number.isFinite(checksum) || checksum === 0) throw new Error(`${voiceCount}-voice run produced an invalid checksum.`);
  return { elapsedMs, finalVoiceCount, checksum };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const measurements = new Map(VOICE_COUNTS.map(count => [count, []]));
for (let warmup = 0; warmup < WARMUPS; warmup++) {
  for (const count of VOICE_COUNTS) measure(count);
}
for (let repetition = 0; repetition < REPETITIONS; repetition++) {
  const order = repetition % 2 ? [...VOICE_COUNTS].reverse() : VOICE_COUNTS;
  for (const count of order) {
    const result = measure(count);
    measurements.get(count).push({ repetition: repetition + 1, ...result });
  }
}

const audioMs = RUN_SECONDS * 1000;
const results = VOICE_COUNTS.map(voiceCount => {
  const runs = measurements.get(voiceCount);
  const elapsed = runs.map(run => run.elapsedMs);
  const medianElapsedMs = median(elapsed);
  return {
    voiceCount,
    voicesPerTrack: voiceCount / DSP.TRACK_INFO.length,
    runs,
    medianElapsedMs,
    minElapsedMs: Math.min(...elapsed),
    maxElapsedMs: Math.max(...elapsed),
    medianMicrosecondsPerQuantum: medianElapsedMs * 1000 / BLOCKS,
    medianRealtimeMargin: audioMs / medianElapsedMs,
    worstRealtimeMargin: audioMs / Math.max(...elapsed),
    medianCpuPercentOfOneCore: medianElapsedMs / audioMs * 100
  };
});

const report = {
  timestamp: new Date().toISOString(),
  methodology: {
    description: 'Production Engine.renderBlock synthesis/mixing stress test with exact active voice counts. Voices are created by Engine.trigger and harvested before normal stealing, then assigned back to the engine. This deliberately bypasses the instrument’s per-track caps; 32 and 64 voices are stress loads, not sequencer-reachable polyphony.',
    sampleRate: SAMPLE_RATE,
    quantumFrames: QUANTUM_FRAMES,
    runSeconds: RUN_SECONDS,
    blocksPerRun: BLOCKS,
    repetitions: REPETITIONS,
    warmupsPerVoiceCount: WARMUPS,
    runOrder: 'Alternating ascending/descending voice counts',
    decay: 'Maximum legal decay per voice; all voices remain active for the complete measured second.',
    delay: 'Send, feedback and mix are zero; production delay-line and master processing still execute.',
    timer: 'Node performance.now() around the complete renderBlock loop, including per-block checksum reads.'
  },
  host: {
    cpu: [...new Set(cpus().map(cpu => cpu.model))].join(', '),
    logicalCores: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    platform: platform(),
    arch: arch(),
    node: process.version,
    v8: process.versions.v8
  },
  quantumBudgetMs: QUANTUM_FRAMES / SAMPLE_RATE * 1000,
  results
};

const artifacts = path.join(ROOT, 'artifacts');
await mkdir(artifacts, { recursive: true });
await writeFile(path.join(artifacts, 'benchmark-results.json'), `${JSON.stringify(report, null, 2)}\n`);
const rows = results.map(result => `| ${result.voiceCount} | ${result.medianElapsedMs.toFixed(3)} | ${result.medianRealtimeMargin.toFixed(2)}× | ${result.worstRealtimeMargin.toFixed(2)}× | ${result.medianCpuPercentOfOneCore.toFixed(2)}% | ${result.medianMicrosecondsPerQuantum.toFixed(2)} |`).join('\n');
const markdown = `# RIFT/16 voice-count benchmark\n\n- Recorded: ${report.timestamp}\n- Host: ${report.host.cpu}; ${report.host.logicalCores} logical cores; ${report.host.memoryGiB.toFixed(1)} GiB RAM; ${report.host.node} / V8 ${report.host.v8}\n- Method: ${report.methodology.description}\n- Each measured run renders ${RUN_SECONDS} second at ${SAMPLE_RATE} Hz in ${BLOCKS} production-sized ${QUANTUM_FRAMES}-frame quanta. ${REPETITIONS} measured runs per count followed ${WARMUPS} warmups; order alternated ascending/descending.\n- All voices remain active throughout. Delay send/feedback/mix are zero; production mixing, delay-line writes, DC blocking and master processing still run. This is a single-thread synthesis CPU benchmark, not an AudioWorklet underrun test.\n\n| Simultaneous voices | Median wall time for 1 s audio (ms) | Median real-time margin | Worst real-time margin | Median one-core CPU | Median µs / 128-frame quantum |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\nThe real-time budget for one quantum is ${report.quantumBudgetMs.toFixed(6)} ms. Raw per-run timings and checksums are in \`benchmark-results.json\`.\n\nReproduce with \`npm run benchmark\`.\n`;
await writeFile(path.join(artifacts, 'benchmark-results.md'), markdown);
console.log(markdown);
