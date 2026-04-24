// AudioWorklet: captures mic samples at 16 kHz, converts Float32 → Int16 PCM,
// and posts binary chunks (~40 ms each) back to the main thread.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.samplesPerChunk = 640; // 40 ms at 16 kHz
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;
    for (let i = 0; i < ch0.length; i++) this.buf.push(ch0[i]);
    while (this.buf.length >= this.samplesPerChunk) {
      const slice = this.buf.splice(0, this.samplesPerChunk);
      const out = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        let s = Math.max(-1, Math.min(1, slice[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-capture", PCMCaptureProcessor);
