# RIFT/16 voice-count benchmark

- Recorded: 2026-11-19T04:30:32.684Z
- Host: 11th Gen Intel(R) Core(TM) i5-11320H @ 3.20GHz; 8 logical cores; 15.8 GiB RAM; v22.4.0 / V8 12.4.254.21-node.15
- Method: Production Engine.renderBlock synthesis/mixing stress test with exact active voice counts. Voices are created by Engine.trigger and harvested before normal stealing, then assigned back to the engine. This deliberately bypasses the instrument’s per-track caps; 32 and 64 voices are stress loads, not sequencer-reachable polyphony.
- Each measured run renders 1 second at 48000 Hz in 375 production-sized 128-frame quanta. 7 measured runs per count followed 2 warmups; order alternated ascending/descending.
- All voices remain active throughout. Delay send/feedback/mix are zero; production mixing, delay-line writes, DC blocking and master processing still run. This is a single-thread synthesis CPU benchmark, not an AudioWorklet underrun test.

| Simultaneous voices | Median wall time for 1 s audio (ms) | Median real-time margin | Worst real-time margin | Median one-core CPU | Median µs / 128-frame quantum |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 1567.586 | 0.64× | 0.63× | 156.76% | 4180.23 |
| 32 | 3090.138 | 0.32× | 0.32× | 309.01% | 8240.37 |
| 64 | 6057.428 | 0.17× | 0.15× | 605.74% | 16153.14 |

The real-time budget for one quantum is 2.666667 ms. Raw per-run timings and checksums are in `benchmark-results.json`.

Reproduce with `npm run benchmark`.
