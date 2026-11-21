// Minimal fullscreen text editor, modeled after GNU nano
class Nano {
  constructor(fs, cwd, filename = '', content = '') {
    this.fs = fs;
    this.cwd = cwd;
    this.filename = filename;
    this.lines = content.length ? content.replace(/\n$/, '').split('\n') : [''];
    if (!this.lines.length) this.lines = [''];
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.dirty = false;
    this.clipboard = null;
    this.mode = 'edit'; // edit | save | search | help | confirm
    this.promptBuf = '';
    this.message = this.welcome;
    this.cols = 80;
    this.rows = 25;
  }

  get welcome() { return 'Welcome to nano. Press Ctrl+G for help.'; }
  get line() { return this.lines[this.row] || ''; }
  get viewRows() { return this.rows - 4; } // title + edit area + message + 2 shortcut rows

  _ensureVisible() {
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + this.viewRows) this.top = this.row - this.viewRows + 1;
  }

  _insert(ch) {
    this.lines[this.row] = this.line.slice(0, this.col) + ch + this.line.slice(this.col);
    this.col++;
    this.dirty = true;
  }

  _enter() {
    this.lines.splice(this.row + 1, 0, this.line.slice(this.col));
    this.lines[this.row] = this.line.slice(0, this.col);
    this.row++;
    this.col = 0;
    this.dirty = true;
    this._ensureVisible();
  }

  _backspace() {
    if (this.col > 0) {
      this.lines[this.row] = this.line.slice(0, this.col - 1) + this.line.slice(this.col);
      this.col--;
      this.dirty = true;
    } else if (this.row > 0) {
      const prevLen = this.lines[this.row - 1].length;
      this.lines[this.row - 1] += this.line;
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prevLen;
      this.dirty = true;
      this._ensureVisible();
    }
  }

  _delete() {
    if (this.col < this.line.length) {
      this.lines[this.row] = this.line.slice(0, this.col) + this.line.slice(this.col + 1);
      this.dirty = true;
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] += this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
      this.dirty = true;
    }
  }

  _move(dr, dc) {
    if (dr) {
      this.row = Math.max(0, Math.min(this.lines.length - 1, this.row + dr));
      this.col = Math.min(this.col, this.line.length);
      this._ensureVisible();
    } else {
      this.col = Math.max(0, Math.min(this.line.length, this.col + dc));
    }
  }

  _save() {
    const name = this.promptBuf.trim();
    if (!name) { this.mode = 'edit'; this.message = 'Write cancelled'; return; }
    const target = this.cwd === '/' ? '/' + name : this.cwd + '/' + name;
    const err = this.fs.writeFile(target, this.lines.join('\n') + '\n');
    this.mode = 'edit';
    if (err) {
      this.message = `Write error: ${err}`;
    } else {
      this.filename = name;
      this.dirty = false;
      this.message = `Wrote "${name}" (${this.lines.length} lines)`;
    }
  }

  _search() {
    const needle = this.promptBuf;
    this.mode = 'edit';
    if (!needle) { this.message = 'Search cancelled'; return; }
    for (let r = this.row; r < this.lines.length; r++) {
      const from = r === this.row ? this.col + 1 : 0;
      const idx = this.lines[r].indexOf(needle, from);
      if (idx >= 0) {
        this.row = r;
        this.col = idx;
        this._ensureVisible();
        this.message = `Found: ${needle}`;
        return;
      }
    }
    this.message = `Not found: ${needle}`;
  }

  onKey(key) {
    if (this.mode === 'help') {
      this.mode = 'edit';
      this.message = this.welcome;
      return { exit: false };
    }
    if (this.mode === 'save' || this.mode === 'search') {
      if (key === 'Enter') {
        this.mode === 'save' ? this._save() : this._search();
        return { exit: false };
      }
      if (key === 'Escape') { this.mode = 'edit'; this.message = 'Cancelled'; return { exit: false }; }
      if (key === 'Backspace') this.promptBuf = this.promptBuf.slice(0, -1);
      else if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) this.promptBuf += key;
      return { exit: false };
    }
    if (this.mode === 'confirm') {
      const k = key.toLowerCase();
      if (k === 'y') {
        if (this.filename) { this.promptBuf = this.filename; this._save(); }
        else { this.mode = 'save'; this.promptBuf = ''; this.message = 'File name to write:'; }
        return { exit: !this.dirty };
      }
      if (k === 'n') return { exit: true };
      if (key === 'Escape') { this.mode = 'edit'; this.message = this.welcome; return { exit: false }; }
      return { exit: false };
    }

    switch (key) {
      case 'Ctrl+X':
        if (this.dirty) {
          this.mode = 'confirm';
          this.message = 'Save changes before exit? Y(yes) N(no) ^C(cancel)';
        } else return { exit: true };
        break;
      case 'Ctrl+O': this.mode = 'save'; this.promptBuf = this.filename; this.message = 'File name to write:'; break;
      case 'Ctrl+W': this.mode = 'search'; this.promptBuf = ''; this.message = 'Search string:'; break;
      case 'Ctrl+G': this.mode = 'help'; break;
      case 'Ctrl+C': this.message = `line ${this.row + 1}/${this.lines.length}, col ${this.col + 1}`; break;
      case 'Ctrl+K':
        this.clipboard = this.line;
        this.lines.splice(this.row, 1);
        if (!this.lines.length) this.lines = [''];
        this.row = Math.min(this.row, this.lines.length - 1);
        this.col = 0;
        this.dirty = true;
        this.message = 'Line cut';
        break;
      case 'Ctrl+U':
        if (this.clipboard !== null) {
          this.lines.splice(this.row, 0, this.clipboard);
          this.dirty = true;
          this.message = 'Pasted';
          this._ensureVisible();
        } else this.message = 'Clipboard empty';
        break;
      case 'Enter': this._enter(); break;
      case 'Backspace': this._backspace(); break;
      case 'Delete': this._delete(); break;
      case 'Tab': this._insert(' '); this._insert(' '); break;
      case 'ArrowLeft': this._move(0, -1); break;
      case 'ArrowRight': this._move(0, 1); break;
      case 'ArrowUp': this._move(-1, 0); break;
      case 'ArrowDown': this._move(1, 0); break;
      case 'Home': this.col = 0; break;
      case 'End': this.col = this.line.length; break;
      default:
        if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) this._insert(key);
    }
    return { exit: false };
  }

  render() {
    const pad = s => s.slice(0, this.cols).padEnd(this.cols, ' ');
    const grid = [];
    let title = 'GNU nano 8.7.1';
    if (this.filename) title += '  ' + this.filename;
    else title += '  New Buffer';
    if (this.dirty) title += ' *';
    grid.push(pad(' '.repeat(Math.max(0, Math.floor((this.cols - title.length) / 2))) + title));

    for (let r = 0; r < this.viewRows; r++) {
      grid.push(pad(this.lines[this.top + r] || ''));
    }

    let msg = this.message;
    if (this.mode === 'save' || this.mode === 'search') msg += ' ' + this.promptBuf;
    grid.push(pad('[' + msg + ']'));
    grid.push(pad('^G Help   ^O Write   ^K Cut   ^U Paste   ^X Exit'));
    grid.push(pad('^C Pos    ^W Search  ^O Write   ^\\ Replace M-U Undo'));
    return grid;
  }
}

module.exports = { Nano };
