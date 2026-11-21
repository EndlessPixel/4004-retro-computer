const path = require('path');
const nodeFs = require('fs');

// CRT 屏保：把 █ 文本画当位图滚动穿过屏幕
// 文件名含 "block" 的从上到下滚动，其余（默认 4004-SYSTEM）横向滚动
const BLOCK = '\xdb'; // CP437 全亮块，PSF 字模 219

class Screensaver {
  constructor(cols = 80, rows = 25, file = null) {
    this.cols = cols;
    this.rows = rows;
    const dir = path.join(__dirname, 'assets', 'screensavers');
    this.file = file
      ? (path.isAbsolute(file) ? file : path.join(dir, file))
      : path.join(dir, '4004-SYSTEM.txt');
    this.bitmap = this._load();
    const base = path.basename(this.file, path.extname(this.file));
    this.vertical = base.toLowerCase().includes('block');
    this.h = this.bitmap.length;
    this.w = Math.max(...this.bitmap.map(r => r.length));
    if (this.vertical) this.offset = -this.h; // 从顶部屏幕外进入
    else this.offset = this.cols;             // 从右侧屏幕外进入
  }

  _load() {
    const text = nodeFs.readFileSync(this.file, 'utf8');
    const lines = text.split('\n').filter(l => l.length);
    return lines.map(l => Array.from(l).map(c => (c === '\u2588' || c === BLOCK || c === '#') ? 1 : 0));
  }

  step() {
    if (this.vertical) {
      this.offset++;
      if (this.offset > this.rows) this.offset = -this.h; // 移出底部后从顶部重新进入
    } else {
      this.offset--;
      if (this.offset < -this.w) this.offset = this.cols; // 移出左侧后从右侧重新进入
    }
  }

  render() {
    const grid = Array.from({ length: this.rows }, () => new Array(this.cols).fill(' '));
    if (this.vertical) {
      // 从上到下：位图水平居中，垂直位置随 offset 下移
      const left = Math.max(0, Math.floor((this.cols - this.w) / 2));
      for (let r = 0; r < this.h; r++) {
        const y = this.offset + r;
        if (y < 0 || y >= this.rows) continue;
        for (let c = 0; c < this.bitmap[r].length; c++) {
          const x = left + c;
          if (x >= 0 && x < this.cols && this.bitmap[r][c]) grid[y][x] = BLOCK;
        }
      }
    } else {
      // 横向：位图垂直居中，整体左移
      const top = Math.floor((this.rows - this.h) / 2);
      for (let r = 0; r < this.h; r++) {
        const y = top + r;
        if (y < 0 || y >= this.rows) continue;
        for (let x = 0; x < this.cols; x++) {
          const src = x - this.offset;
          if (src < 0 || src >= this.bitmap[r].length) continue;
          if (this.bitmap[r][src]) grid[y][x] = BLOCK;
        }
      }
    }
    return grid.map(row => row.join(''));
  }
}

module.exports = { Screensaver };
