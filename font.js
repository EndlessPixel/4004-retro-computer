const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// PSF1 字体解析：8x8 点阵，256 字形。字体文件随仓库分发，跨平台可用。
class Font {
  constructor(file = path.join(__dirname, 'assets', 'Lat15-VGA8.psf.gz')) {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    if (raw[0] !== 0x36 || raw[1] !== 0x04) throw new Error('not a PSF1 font');
    this.width = 8;
    this.height = raw[3];
    this.charsize = raw[3];
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
