const zlib = require('zlib');
const fs = require('fs');

// PSF1 字体解析：8x8 点阵，256 字形
class Font {
  constructor(file) {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    if (raw[0] !== 0x36 || raw[1] !== 0x04) throw new Error('not a PSF1 font');
    this.mode = raw[2];
    this.charsize = raw[3]; // 每字形字节数 = 高度（宽度固定 8）
    this.height = this.charsize;
    this.width = 8;
    this.glyphs = [];
    for (let c = 0; c < 256; c++) {
      this.glyphs.push(raw.subarray(4 + c * this.charsize, 4 + (c + 1) * this.charsize));
    }
  }

  glyph(code) {
    return this.glyphs[code & 0xff] || this.glyphs[0];
  }
}

module.exports = { Font };
