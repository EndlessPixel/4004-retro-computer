// 后端帧缓冲：80x25 字符网格，用 PSF 字模渲染成 1bpp 像素
class Framebuffer {
  constructor(font, cols = 80, rows = 25) {
    this.font = font;
    this.cols = cols;
    this.rows = rows;
    this.cw = font.width;
    this.ch = font.height;
    this.width = cols * this.cw;
    this.height = rows * this.ch;
    this.cells = new Uint8Array(cols * rows).fill(0x20);
    this.cx = 0;
    this.cy = 0;
    this.cursorOn = true;
    this.pixels = new Uint8Array((this.width / 8) * this.height);
    this.scrollback = [];   // 被顶出屏幕的历史行（Uint8Array，每行 cols 字节）
    this.scrollPos = 0;     // 0 = 实时视图；>0 = 向上查看历史的行数
    this.maxScrollback = 500;
  }

  clear() {
    this.cells.fill(0x20);
    this.cx = 0;
    this.cy = 0;
    this.scrollback = [];
    this.scrollPos = 0;
  }

  // 回滚：scrollPos 是向上翻的行数，0 表示实时视图
  scrollUp(n = 1) {
    this.scrollPos = Math.min(this.scrollback.length, this.scrollPos + n);
  }
  scrollDown(n = 1) {
    this.scrollPos = Math.max(0, this.scrollPos - n);
  }
  resetScroll() { this.scrollPos = 0; }

  // 取屏幕上第 row 行要显示的内容（考虑回滚视图）
  _visibleRow(row) {
    const top = this.scrollback.length - this.scrollPos;
    const v = top + row;
    if (v < this.scrollback.length) return this.scrollback[v];
    const idx = (v - this.scrollback.length) * this.cols;
    return this.cells.subarray(idx, idx + this.cols);
  }

  // 用字符网格整屏替换（nano 等全屏程序使用）
  setCells(grid) {
    this.resetScroll();
    this.cells.fill(0x20);
    for (let r = 0; r < Math.min(grid.length, this.rows); r++) {
      const line = grid[r];
      for (let c = 0; c < Math.min(line.length, this.cols); c++) {
        this.cells[r * this.cols + c] = line.charCodeAt(c) & 0xff;
      }
    }
  }

  goto(col, row) {
    this.cx = Math.max(0, Math.min(this.cols - 1, col));
    this.cy = Math.max(0, Math.min(this.rows - 1, row));
  }

  _lineFeed() {
    if (this.cy + 1 >= this.rows) {
      this.scrollback.push(this.cells.slice(0, this.cols));
      if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
      this.cells.copyWithin(0, this.cols);
      this.cells.fill(0x20, (this.rows - 1) * this.cols);
      this.cy = this.rows - 1;
    } else {
      this.cy += 1;
    }
  }

  writeChar(code) {
    if (code === 13) { this.cx = 0; return; }
    if (code === 10) { this.cx = 0; this._lineFeed(); return; }
    if (code === 8) { if (this.cx > 0) this.cx -= 1; return; }
    if (code === 9) { this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8); return; }
    if (code === 0x1b) return;
    if (code < 32 || code > 126) code = 0x3f;
    this.cells[this.cy * this.cols + this.cx] = code;
    this.cx += 1;
    if (this.cx >= this.cols) {
      this.cx = 0;
      this._lineFeed();
    }
  }

  write(text) {
    this.resetScroll(); // 新输出时回到实时视图
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x1b && text.slice(i, i + 4) === '\x1b[2J') { this.clear(); i += 3; continue; }
      if (c === 0x1b && text.slice(i, i + 3) === '\x1b[H') { this.cx = 0; this.cy = 0; i += 2; continue; }
      this.writeChar(c);
    }
  }

  // 渲染一个单元格；line 为可见行数据
  _renderCell(line, col, row, invert) {
    const code = line[col];
    const glyph = this.font.glyph(code);
    const x0 = col * this.cw;
    const y0 = row * this.ch;
    const stride = this.width / 8;
    for (let y = 0; y < this.ch; y++) {
      const bits = glyph[y] || 0;
      for (let x = 0; x < this.cw; x++) {
        const on = (bits & (0x80 >> x)) !== 0;
        const lit = invert ? !on : on;
        if (lit) this.pixels[(y0 + y) * stride + ((x0 + x) >> 3)] |= 0x80 >> ((x0 + x) & 7);
      }
    }
  }

  render(cursorOn = this.cursorOn) {
    this.pixels.fill(0);
    for (let row = 0; row < this.rows; row++) {
      const line = this._visibleRow(row);
      for (let col = 0; col < this.cols; col++) {
        // 回滚视图不显示光标
        const invert = cursorOn && this.scrollPos === 0 && row === this.cy && col === this.cx;
        this._renderCell(line, col, row, invert);
      }
    }
    return this.pixels;
  }

  frame(cursorOn = this.cursorOn) {
    return {
      width: this.width,
      height: this.height,
      cw: this.cw,
      ch: this.ch,
      pixels: Buffer.from(this.render(cursorOn)).toString('base64')
    };
  }
}

module.exports = { Framebuffer };
