// 终端 I/O：把 CPU 输出的半字节组装成字节流
class Terminal {
  constructor() {
    this.outHigh = 0;
    this.outPhase = 0;
    this.current = '';
    this.inBuffer = [];
  }

  writeNibble(n) {
    n &= 0xf;
    if (this.outPhase === 0) {
      this.outHigh = n;
      this.outPhase = 1;
    } else {
      this.outPhase = 0;
      this.current += String.fromCharCode(((this.outHigh << 4) | n) & 0xff);
    }
  }

  queueInput(str) {
    this.inBuffer = [];
    for (const ch of str) {
      const code = ch.charCodeAt(0) & 0xff;
      this.inBuffer.push((code >> 4) & 0xf, code & 0xf);
    }
  }

  readNibble() {
    return this.inBuffer.length ? this.inBuffer.shift() : 0;
  }

  drainOutput() {
    const out = this.current;
    this.current = '';
    return out;
  }

  reset() {
    this.outHigh = 0;
    this.outPhase = 0;
    this.current = '';
    this.inBuffer = [];
  }
}

module.exports = { Terminal };
