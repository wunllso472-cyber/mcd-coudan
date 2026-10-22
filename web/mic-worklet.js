// 麦克风 → 16kHz / int16 / 单声道，每 20ms（320 个采样，640 字节）发一包
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.prev = 0;
    this.out = new Int16Array(320);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // 线性插值重采样；pos 是相对当前块起点的小数位置，-1 表示上一块的最后一个采样
    let pos = this.pos;
    while (pos < input.length - 1) {
      const i = Math.floor(pos);
      const a = i < 0 ? this.prev : input[i];
      const b = input[i + 1];
      const v = a + (b - a) * (pos - i);
      this.peak = Math.max(this.peak, Math.abs(v));
      this.out[this.n++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      if (this.n === 320) {
        this.port.postMessage({ pcm: this.out.buffer, level: this.peak }, [this.out.buffer]);
        this.out = new Int16Array(320);
        this.n = 0;
        this.peak = 0;
      }
      pos += this.step;
    }
    this.prev = input[input.length - 1];
    this.pos = pos - input.length;
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
