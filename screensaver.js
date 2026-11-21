const path = require('path');
const nodeFs = require('fs');

// CRT 屏保：把 █ 文本画当位图，横向滚动穿过屏幕
const BLOCK = '\xdb'; // CP437 全亮块，PSF 字模 219

class Screensaver {
  constructor(cols = 80, rows = 25, file = null) {
    this.cols = cols;
    this.rows = rows;
    this.file = file || path.join(__dirname, 'assets', 'screensavers', '4004-SYSTEM.txt');
    this.bitmap = this._load();
    this.offset = cols;  // 从右侧屏幕外开始进入
    this.direction = -1; // 向左滚动
  }

  _load() {
    const text = nodeFs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n').filter(l => l.length);
    return lines.map(l => Array.from(l).map(c => (c === '\u2588' || c === BLOCK || c === '#') ? 1 : 0));
  }

  step() {
    const w = this.bitmap[0].length;
    this.offset += this.direction;
    if (this.offset < -w) this.offset = this.cols; // 完全移出后从右侧重新进入
  }

  render() {
    const grid = Array.from({ length: this.rows }, () => new Array(this.cols).fill(' '));
    const h = this.bitmap.length;
    const top = Math.floor((this.rows - h) / 2);
    for (let r = 0; r < h; r++) {
      const y = top + r;
      if (y < 0 || y >= this.rows) continue;
      for (let x = 0; x < this.cols; x++) {
        const src = x - this.offset;
        if (src < 0 || src >= this.bitmap[r].length) continue;
        if (this.bitmap[r][src]) grid[y][x] = BLOCK;
      }
    }
    return grid.map(row => row.join(''));
  }
}

module.exports = { Screensaver };
