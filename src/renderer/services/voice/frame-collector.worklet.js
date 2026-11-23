class FrameCollector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = options.processorOptions.frame;
    this.buffer = new Float32Array(this.frame);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let read = 0;
    while (read < channel.length) {
      const take = Math.min(channel.length - read, this.frame - this.filled);
      this.buffer.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.frame) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.frame);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("nexus-frame-collector", FrameCollector);
