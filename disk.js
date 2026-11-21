const fs = require('fs');

// 简易磁盘：用 .img 文件作为持久化存储，按扇区/字节寻址
class Disk {
  constructor(sectorSize = 256, sectorCount = 16) {
    this.sectorSize = sectorSize;
    this.sectorCount = sectorCount;
    this.image = Buffer.alloc(sectorSize * sectorCount);
    this.path = null;
  }

  open(imgPath) {
    this.path = imgPath;
    if (fs.existsSync(imgPath)) {
      const data = fs.readFileSync(imgPath);
      data.copy(this.image, 0, 0, Math.min(data.length, this.image.length));
    } else {
      this.flush();
    }
  }

  flush() {
    if (this.path) fs.writeFileSync(this.path, this.image);
  }

  _offset(sector, offset) {
    if (sector < 0 || sector >= this.sectorCount) throw new RangeError(`扇区越界: ${sector}`);
    if (offset < 0 || offset >= this.sectorSize) throw new RangeError(`扇区内偏移越界: ${offset}`);
    return sector * this.sectorSize + offset;
  }

  readByte(sector, offset) {
    return this.image[this._offset(sector, offset)];
  }

  writeByte(sector, offset, value) {
    this.image[this._offset(sector, offset)] = value & 0xff;
    this.flush();
  }

  readSector(sector) {
    const start = this._offset(sector, 0);
    return this.image.subarray(start, start + this.sectorSize);
  }
}

module.exports = { Disk };
