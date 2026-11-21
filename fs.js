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
    for (let i = 0; i < ENTRY_SIZE; i++) this.disk.writeByte(sector, base + i, 0);
    for (let i = 0; i < 8; i++) {
      this.disk.writeByte(sector, base + i, i < name.length ? name.charCodeAt(i) : 0);
    }
    this.disk.writeByte(sector, base + 8, type.charCodeAt(0));
    this.disk.writeByte(sector, base + 9, dataSector);
  }

  _readEntries(sector) {
    const entries = [];
    // 第 15 项保留给扇区末字节的格式化标记
    for (let i = 0; i < 15; i++) {
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

  // path 为规范化的绝对路径。返回所在目录扇区、名字、目录项与索引
  _locate(path) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return null;
    const name = parts.pop();
    const parent = this.resolve('/' + parts.join('/'));
    if (parent === null) return null;
    const entries = this._readEntries(parent);
    const index = entries.findIndex(e => e.name === name);
    return { parent, name, index, entry: index >= 0 ? entries[index] : null };
  }

  stat(path) {
    if (!path || path === '/') return { type: 'd', sector: ROOT_SECTOR, name: '/' };
    const loc = this._locate(path);
    return loc && loc.entry ? loc.entry : null;
  }

  _usedSectors() {
    const used = new Set([0, 1]);
    const walk = (s) => {
      if (used.has(s)) return;
      used.add(s);
      for (const e of this._readEntries(s)) {
        if (e.type === 'd') walk(e.sector);
        else used.add(e.sector);
      }
    };
    walk(ROOT_SECTOR);
    return used;
  }

  _allocSector() {
    const used = this._usedSectors();
    for (let s = 2; s < this.disk.sectorCount; s++) {
      if (!used.has(s)) return s;
    }
    return null;
  }

  _clearSector(sector) {
    for (let i = 0; i < this.disk.sectorSize; i++) this.disk.writeByte(sector, i, 0);
  }

  _copySector(src, dst) {
    for (let i = 0; i < this.disk.sectorSize; i++) {
      this.disk.writeByte(dst, i, this.disk.readByte(src, i));
    }
  }

  _addEntry(dirSector, name, type, dataSector) {
    const index = this._readEntries(dirSector).length;
    if (index >= 15) return false;
    this._writeEntry(dirSector, index, name, type, dataSector);
    return true;
  }

  _removeEntry(dirSector, name) {
    const entries = this._readEntries(dirSector);
    const idx = entries.findIndex(e => e.name === name);
    if (idx < 0) return false;
    for (let i = idx; i < entries.length - 1; i++) {
      const e = entries[i + 1];
      this._writeEntry(dirSector, i, e.name, e.type, e.sector);
    }
    const base = (entries.length - 1) * ENTRY_SIZE;
    for (let i = 0; i < ENTRY_SIZE; i++) this.disk.writeByte(dirSector, base + i, 0);
    return true;
  }

  mkdir(path) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return 'exists';
    const name = parts.pop();
    if (name.length > 8) return 'name too long';
    const parent = this.resolve('/' + parts.join('/'));
    if (parent === null) return 'no such directory';
    if (this._readEntries(parent).some(e => e.name === name)) return 'exists';
    const sector = this._allocSector();
    if (sector === null) return 'no free sector';
    this._clearSector(sector);
    return this._addEntry(parent, name, 'd', sector) ? null : 'directory full';
  }

  writeFile(path, text) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return 'invalid path';
    const name = parts.pop();
    if (name.length > 8) return 'name too long';
    const parent = this.resolve('/' + parts.join('/'));
    if (parent === null) return 'no such directory';
    const existing = this.stat(path);
    if (existing && existing.type === 'd') return 'is a directory';
    let sector;
    if (existing) {
      sector = existing.sector;
    } else {
      sector = this._allocSector();
      if (sector === null) return 'no free sector';
      if (!this._addEntry(parent, name, 'f', sector)) return 'directory full';
    }
    this._writeFile(sector, text);
    return null;
  }

  rm(path) {
    if (path === '/') return 'is a directory';
    const loc = this._locate(path);
    if (!loc || !loc.entry) return 'no such file';
    if (loc.entry.type === 'd') return 'is a directory';
    this._removeEntry(loc.parent, loc.name);
    this._clearSector(loc.entry.sector);
    return null;
  }

  cp(src, dst) {
    const st = this.stat(src);
    if (!st) return 'no such file';
    if (st.type === 'd') return 'omitting directory';
    const dstStat = this.stat(dst);
    const base = src.split('/').filter(Boolean).pop();
    const target = dstStat && dstStat.type === 'd'
      ? (dst === '/' ? '' : dst) + '/' + base
      : dst;
    if (target === src) return 'same file';
    const content = this.readFile(src);
    return this.writeFile(target, content);
  }

  mv(src, dst) {
    const st = this.stat(src);
    if (!st) return 'no such file';
    let target = dst;
    const dstStat = this.stat(dst);
    if (dstStat && dstStat.type === 'd') {
      const base = src.split('/').filter(Boolean).pop();
      target = (dst === '/' ? '' : dst) + '/' + base;
    }
    if (target === src) return null;
    if (st.type === 'd' && target.startsWith(src + '/')) return 'invalid argument';

    const tParts = target.split('/').filter(Boolean);
    if (!tParts.length) return 'invalid path';
    const tName = tParts.pop();
    if (tName.length > 8) return 'name too long';
    const tParent = this.resolve('/' + tParts.join('/'));
    if (tParent === null) return 'no such directory';
    const tStat = this.stat(target);
    if (tStat && tStat.type === 'd') return 'is a directory';

    const sParts = src.split('/').filter(Boolean);
    const sName = sParts.pop();
    const sParent = this.resolve('/' + sParts.join('/'));

    if (sParent === tParent && !tStat) {
      this._writeEntry(sParent, this._locate(src).index, tName, st.type, st.sector);
      return null;
    }

    if (st.type === 'd') {
      if (tStat) {
        this._removeEntry(tParent, tName);
        if (tStat.type === 'f') this._clearSector(tStat.sector);
      } else if (this._readEntries(tParent).length >= 15) {
        return 'directory full';
      }
      this._addEntry(tParent, tName, 'd', st.sector);
      this._removeEntry(sParent, sName);
      return null;
    }

    let newSector;
    if (tStat) {
      newSector = tStat.sector;
    } else {
      newSector = this._allocSector();
      if (newSector === null) return 'no free sector';
    }
    this._copySector(st.sector, newSector);
    if (!tStat) {
      if (!this._addEntry(tParent, tName, 'f', newSector)) return 'directory full';
      this._clearSector(st.sector);
    }
    this._removeEntry(sParent, sName);
    return null;
  }
}

module.exports = { FileSystem };
