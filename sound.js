// 8-bit 声卡：8kHz 采样率，8-bit unsigned PCM，方波/正弦/三角波
class SoundCard {
  constructor(sampleRate = 8000) {
    this.sampleRate = sampleRate;
    this.bits = 8;
    this.volume = 64; // 0-255，静音中心 128
    this.enabled = true;
    this.lastFreq = 0;
    this.lastDuration = 0;
    this.lastWave = 'square';
    this.playCount = 0;
    this.samples = 0;
  }

  status() {
    return {
      enabled: this.enabled,
      bits: this.bits,
      rate: this.sampleRate,
      volume: this.volume,
      lastFreq: this.lastFreq,
      wave: this.lastWave,
      plays: this.playCount,
      samples: this.samples
    };
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(255, v));
    return this.volume;
  }

  // 生成 8-bit unsigned PCM 采样数组
  tone(freq = 440, durationMs = 200, wave = 'square') {
    const count = Math.max(1, Math.floor(this.sampleRate * durationMs / 1000));
    const data = new Uint8Array(count);
    const amp = Math.min(127, this.volume);
    for (let i = 0; i < count; i++) {
      const phase = (i * freq / this.sampleRate) % 1;
      let v;
      if (wave === 'sine') v = Math.sin(phase * 2 * Math.PI);
      else if (wave === 'triangle') v = 1 - 4 * Math.abs(phase - 0.5);
      else v = phase < 0.5 ? 1 : -1; // square
      data[i] = Math.max(0, Math.min(255, Math.round(128 + v * amp)));
    }
    this.lastFreq = freq;
    this.lastDuration = durationMs;
    this.lastWave = wave;
    this.playCount++;
    this.samples += count;
    return data;
  }
}

module.exports = { SoundCard };
