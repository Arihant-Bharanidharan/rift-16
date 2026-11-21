/* Served by server.mjs as a bundle immediately after dsp-core.cjs. */
class RiftEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new RiftDSP.Engine(RiftDSP.createDefaultState(), sampleRate);
    this.capture = null;
    this.lastStep = -2;
    this.lastPlaying = false;
    this.port.onmessage = event => {
      const message = event.data || {};
      if (message.type === 'state') {
        this.engine.setState(message.state);
      } else if (message.type === 'capture') {
        const frames = Number(message.frames);
        this.capture = Number.isInteger(frames) && frames > 0 ? {
          left: new Float32Array(frames),
          right: new Float32Array(frames),
          offset: 0,
          active: false
        } : null;
      } else if (message.type === 'transport') {
        if (message.action === 'play') {
          this.engine.stepLimit = Number.isInteger(message.stepLimit) && message.stepLimit > 0
            ? message.stepLimit
            : Infinity;
          if (this.capture) {
            this.capture.offset = 0;
            this.capture.active = true;
          }
          this.engine.start();
        } else if (message.action === 'pause') {
          this.engine.pause();
        } else if (message.action === 'resume') {
          this.engine.resume();
        } else if (message.action === 'stop') {
          this.engine.stop();
          if (this.capture) this.capture.active = false;
        }
        this.postPosition(true);
      } else if (message.type === 'audition') {
        this.engine.trigger(message.track, message.note, message.velocity, 0.5);
      }
    };
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  postPosition(force) {
    const step = this.engine.currentStep;
    const playing = this.engine.playing;
    if (force || step !== this.lastStep || playing !== this.lastPlaying) {
      this.port.postMessage({ type: 'position', step, playing, samplePosition: this.engine.samplePosition });
      this.lastStep = step;
      this.lastPlaying = playing;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    this.engine.renderBlock(output[0], output[1]);
    const capture = this.capture;
    if (capture && capture.active) {
      const frames = Math.min(output[0].length, capture.left.length - capture.offset);
      capture.left.set(output[0].subarray(0, frames), capture.offset);
      capture.right.set(output[1].subarray(0, frames), capture.offset);
      capture.offset += frames;
      if (capture.offset === capture.left.length) {
        this.capture = null;
        this.port.postMessage({
          type: 'capture-complete',
          sampleRate,
          left: capture.left,
          right: capture.right
        }, [capture.left.buffer, capture.right.buffer]);
      }
    }
    this.postPosition(false);
    return true;
  }
}

registerProcessor('rift-engine', RiftEngineProcessor);
