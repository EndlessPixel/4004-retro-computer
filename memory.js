// Intel 4002 RAM + ROM：独立于 CPU 的存储硬件
class Memory {
  constructor() {
    this.rom = new Uint8Array(4096);
    this.ram = Array.from({ length: 16 }, () =>
      Array.from({ length: 4 }, () => new Uint8Array(16))
    );
    this.status = Array.from({ length: 16 }, () =>
      Array.from({ length: 4 }, () => new Uint8Array(4))
    );
    this.chip = 0;
    this.bank = 0;
  }

  loadRom(bin) {
    const len = Math.min(bin.length, 4096);
    for (let i = 0; i < len; i++) this.rom[i] = bin[i] & 0xff;
  }

  readRom(addr) {
    return this.rom[addr & 0xfff];
  }

  select(chip, bank) {
    this.chip = chip & 0xf;
    this.bank = bank & 0x3;
  }

  resetSelection() {
    this.chip = 0;
    this.bank = 0;
  }

  readRam(addr) {
    return this.ram[this.chip][this.bank][addr & 0xf];
  }

  writeRam(addr, value) {
    this.ram[this.chip][this.bank][addr & 0xf] = value & 0xf;
  }

  readStatus(idx) {
    return this.status[this.chip][this.bank][idx & 0x3];
  }

  writeStatus(idx, value) {
    this.status[this.chip][this.bank][idx & 0x3] = value & 0xf;
  }

  // free 用：4002 RAM 容量（半字节）
  ramUsage() {
    let total = 0, used = 0;
    for (const chip of this.ram) {
      for (const bank of chip) {
        for (const nibble of bank) {
          total++;
          if (nibble !== 0) used++;
        }
      }
    }
    return { total, used, free: total - used };
  }
}

module.exports = { Memory };
