// 极简文件系统：目录项存在 img 的保留扇区里
const ENTRY_SIZE = 16;
const ROOT_SECTOR = 2;
const HOME_SECTOR = 3;
const USER_SECTOR = 4;
const FORMAT_VERSION = 2;

class FileSystem {
  constructor(disk) {
    this.disk = disk;
  }

  isFormatted() {
    return this.disk.readByte(ROOT_SECTOR, 255) === FORMAT_VERSION;
  }

  format() {
    for (let s = 2; s < 16; s++) {
      for (let i = 0; i < 256; i++) this.disk.writeByte(s, i, 0);
    }
    this._writeEntry(ROOT_SECTOR, 0, 'home', 'd', HOME_SECTOR);
    this._writeEntry(ROOT_SECTOR, 1, 'echo', 'f', 1);
    this._writeEntry(ROOT_SECTOR, 2, 'README', 'f', 5);
    this._writeEntry(HOME_SECTOR, 0, 'user', 'd', USER_SECTOR);
    this._writeEntry(HOME_SECTOR, 1, 'notes', 'f', 6);
    this._writeFile(5, '4004 SYSTEM\nTYPE HELP FOR COMMANDS\n');
    this._writeFile(6, 'HELLO FROM HOME\n');
    this.disk.writeByte(ROOT_SECTOR, 255, FORMAT_VERSION);
  }

  _writeFile(sector, text) {
    for (let i = 0; i < text.length; i++) this.disk.writeByte(sector, i, text.charCodeAt(i) & 0xff);
    this.disk.writeByte(sector, text.length, 0);
  }

  _writeEntry(sector, index, name, type, dataSector) {
    const base = index * ENTRY_SIZE;
    for (let i = 0; i < 8; i++) {
      this.disk.writeByte(sector, base + i, i < name.length ? name.charCodeAt(i) : 0);
    }
    this.disk.writeByte(sector, base + 8, type.charCodeAt(0));
    this.disk.writeByte(sector, base + 9, dataSector);
  }

  _readEntries(sector) {
    const entries = [];
    for (let i = 0; i < 16; i++) {
      const base = i * ENTRY_SIZE;
      const nameBytes = [];
      for (let j = 0; j < 8; j++) {
        const b = this.disk.readByte(sector, base + j);
        if (b === 0) break;
        nameBytes.push(b);
      }
      if (!nameBytes.length) break;
      entries.push({
        name: String.fromCharCode(...nameBytes),
        type: String.fromCharCode(this.disk.readByte(sector, base + 8)),
        sector: this.disk.readByte(sector, base + 9)
      });
    }
    return entries;
  }

  resolve(path) {
    if (!path || path === '/') return ROOT_SECTOR;
    let sector = ROOT_SECTOR;
    for (const part of path.split('/').filter(Boolean)) {
      const entry = this._readEntries(sector).find(e => e.name === part && e.type === 'd');
      if (!entry) return null;
      sector = entry.sector;
    }
    return sector;
  }

  list(path) {
    const sector = this.resolve(path);
    if (sector === null) return null;
    return this._readEntries(sector);
  }

  readFile(path) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    const name = parts.pop();
    const dirSector = this.resolve('/' + parts.join('/'));
    if (dirSector === null) return null;
    const entry = this._readEntries(dirSector).find(e => e.name === name && e.type === 'f');
    if (!entry) return null;
    const bytes = [];
    for (let i = 0; i < 256; i++) {
      const b = this.disk.readByte(entry.sector, i);
      if (b === 0) break;
      bytes.push(b);
    }
    return String.fromCharCode(...bytes);
  }
}

module.exports = { FileSystem };
