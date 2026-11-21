const path = require('path');
const fs = require('fs');
const { Memory } = require('./memory');
const { Disk } = require('./disk');

class Intel4004 {
  constructor() {
    this.memory = new Memory();
    this.disk = new Disk();
    this.diskSector = 0;
    this.diskOffset = 0;
    this.reg = new Uint8Array(16);
    this.A = 0;
    this.C = 0;
    this.PC = 0;
    this.stop = false;

    // 时序
    this.T = 0;          // T 0~7，每个M-cycle内部状态
    this.cycle = 0;      // 全局时钟tick计数
    this.mcycle = 0;     // 当前这条指令的第几个M-cycle（0开始）
    this.maxMcycle = 1;  // 当前指令一共需要多少M-cycle
    this.instPC = 0;     // 指令起始PC
    this.instOpcode = 0; // 指令操作码
    this.operandBuf = [];// 参数字节缓存（第2字节）
    this.bus = 0;        // 简化总线
    this.addr = 0;       // 12bit ROM地址总线
  }

  loadRom(bin) {
    this.memory.loadRom(bin);
    this.reset();
  }

  attachDisk(imgPath) {
    this.disk.open(imgPath);
  }

  reset() {
    this.PC = 0;
    this.A = 0;
    this.C = 0;
    this.reg.fill(0);
    this.stop = false;
    this.memory.resetSelection();
    this.diskSector = 0;
    this.diskOffset = 0;

    this.T = 0;
    this.cycle = 0;
    this.mcycle = 0;
    this.maxMcycle = 1;
    this.instPC = 0;
    this.instOpcode = 0;
    this.operandBuf = [];
    this.bus = 0;
    this.addr = 0;
  }

  _diskSync() {
    if (this.reg[0] !== this.diskSector) {
      this.diskSector = this.reg[0] & 0xf;
      this.diskOffset = 0;
    }
  }

  _diskWriteNibble(nibble) {
    this._diskSync();
    const byteOff = this.diskOffset >> 1;
    let v = this.disk.readByte(this.diskSector, byteOff);
    if (this.diskOffset & 1) v = (v & 0xf0) | (nibble & 0x0f);
    else v = (v & 0x0f) | ((nibble & 0x0f) << 4);
    this.disk.writeByte(this.diskSector, byteOff, v);
    this.diskOffset += 1;
  }

  _diskReadNibble() {
    this._diskSync();
    const v = this.disk.readByte(this.diskSector, this.diskOffset >> 1);
    const nibble = (this.diskOffset & 1) ? (v & 0x0f) : (v >> 4);
    this.diskOffset += 1;
    return nibble;
  }

  _getInstMcycles(opcode) {
    const high = (opcode >> 4) & 0x0f;
    const low = opcode & 0x0f;
    switch (high) {
      case 0x1: return 2;       // JCN 2字节
      case 0x2: return low < 8 ? 2 : 1; // FIM=2，JIN=1
      case 0x3: return low < 8 ? 2 : 3; // FIN=2，JUN=3
      case 0x4: return 3;       // JMS 3字节
      case 0x6: return 2;       // ISZ 2字节
      case 0xB: return 1;       // BBL 单字节！low是立即数
      default: return 1;        // 其余都是1字节
    }
  }

  _isFetchCycle() {
    // 4004 的 3-M-cycle 指令（JUN/JMS）只有 2 字节，最后一个M-cycle只执行不取指
    return this.mcycle === 0 || (this.mcycle === 1 && this.maxMcycle >= 2);
  }

  _executeStage(mc) {
    const op = this.instOpcode;
    const high = (op >> 4) & 0x0f;
    const low = op & 0x0f;

    if (mc === 0) {
      // 1字节指令在这里执行
      switch (high) {
        case 0x0: // NOP
          break;
        case 0x5: // INC r
          this.reg[low] = (this.reg[low] + 1) & 0xf;
          break;
        case 0x7: { // ADD r
          const sum = this.A + this.reg[low] + this.C;
          this.A = sum & 0xf;
          this.C = (sum >> 4) & 1;
          break;
        }
        case 0x8: { // SUB r
          const sub = this.A - this.reg[low] - this.C;
          this.A = sub & 0xf;
          this.C = sub >= 0 ? 1 : 0;
          break;
        }
        case 0x9: // LD r
          this.A = this.reg[low];
          break;
        case 0xA: { // XCH r
          const t = this.A;
          this.A = this.reg[low];
          this.reg[low] = t;
          break;
        }
        case 0xB: // BBL 单字节，mc=0执行
          this.A = low;
          this.PC = ((this.reg[15] & 0xf) << 8) | this.reg[14];
          break;
        case 0xC: // LDM
          this.A = low;
          break;
        case 0xD: { // ADDM
          const sum = this.A + low + this.C;
          this.A = sum & 0xf;
          this.C = (sum >> 4) & 1;
          break;
        }
        case 0xE: { // SUBM
          const sub = this.A - low - this.C;
          this.A = sub & 0xf;
          this.C = sub >= 0 ? 1 : 0;
          break;
        }
        case 0xF:
          switch (low) {
            case 0x0: // WRM
              this.memory.writeRam(this.reg[0] & 0xf, this.A & 0xf);
              break;
            case 0x1: // WRR
              this._diskWriteNibble(this.A);
              break;
            case 0x2: // WPM
              break;
            case 0x3: // WR0
              this.memory.writeStatus(0, this.A & 0xf);
              break;
            case 0x4: // WR1
              this.memory.writeStatus(1, this.A & 0xf);
              break;
            case 0x5: // WR2
              this.memory.writeStatus(2, this.A & 0xf);
              break;
            case 0x6: // WR3
              this.memory.writeStatus(3, this.A & 0xf);
              break;
            case 0x7: // SBM
              this.A = this.memory.readStatus(0) & 0xf;
              break;
            case 0x8: // RDM
              this.A = this.memory.readRam(this.reg[0] & 0xf) & 0xf;
              break;
            case 0x9: // RDR
              this.A = this._diskReadNibble();
              break;
            case 0xA: // ADM
              {
                const s = this.memory.readStatus(0);
                const sum = this.A + s + this.C;
                this.A = sum & 0xf;
                this.C = (sum >> 4) & 1;
              }
              break;
            case 0xB: // SUBB
              {
                const s = this.memory.readStatus(0);
                const sub = this.A - s - this.C;
                this.A = sub & 0xf;
                this.C = sub >= 0 ? 1 : 0;
              }
              break;
            case 0xC: // LRM
              this.memory.select(this.reg[1] & 0xf, this.reg[2] & 0x3);
              break;
            case 0xD: // OR4
            case 0xE: // OR5
              break;
            case 0xF: // HLT
              this.disk.flush();
              this.stop = true;
              break;
          }
          break;
      }
      return;
    }

    if (mc === 1) {
      const b1 = this.operandBuf[0];
      switch (high) {
        case 0x1: { // JCN cond, addr
          let jump = false;
          if ((low & 0b0001) && this.C === 0) jump = true;
          if ((low & 0b0010) && this.A === 0) jump = true;
          if ((low & 0b0100) && this.C === 1) jump = true;
          if ((low & 0b1000) && this.A !== 0) jump = true;
          const page = this.instPC & 0xf00;
          if (jump) this.PC = (page | b1) & 0xfff;
          break;
        }
        case 0x2: {
          if (low < 8) { // FIM Rp, data
            this.reg[low * 2] = (b1 >> 4) & 0xf;
            this.reg[low * 2 + 1] = b1 & 0xf;
          }
          break;
        }
        case 0x3: {
          if (low < 8) { // FIN Rp, data
            this.reg[low * 2] = (b1 >> 4) & 0xf;
            this.reg[low * 2 + 1] = b1 & 0xf;
          }
          break;
        }
        case 0x6: { // ISZ r, addr
          const rv = (this.reg[low] + 1) & 0xf;
          this.reg[low] = rv;
          const page = this.instPC & 0xf00;
          if (rv !== 0) this.PC = (page | b1) & 0xfff;
          break;
        }
      }
      return;
    }

    if (mc === 2) {
      const b1 = this.operandBuf[0];
      switch (high) {
        case 0x3: { // JUN addr
          const hi = low & 0xf;
          this.PC = ((hi << 8) | b1) & 0xfff;
          break;
        }
        case 0x4: { // JMS addr
          const hi = low & 0xf;
          const lo = b1;
          this.reg[14] = this.PC & 0xff;
          this.reg[15] = (this.PC >> 8) & 0xf;
          this.PC = ((hi << 8) | lo) & 0xfff;
          break;
        }
      }
    }
  }

  tick() {
    if (this.stop) return;
    const t = this.T;
    this.cycle += 1;

    if (t === 0) {
      this.addr = this.PC & 0xfff;
      if (this.mcycle === 0) {
        this.instPC = this.PC & 0xfff;
        this.instOpcode = 0;
        this.operandBuf = [];
      }
    } else if (t === 1) {
      if (this._isFetchCycle()) {
        this.bus = this.memory.readRom(this.addr);
        if (this.mcycle === 0) {
          this.instOpcode = this.bus;
        } else {
          this.operandBuf.push(this.bus);
        }
      } else {
        this.bus = 0;
      }
    } else if (t === 2) {
      if (this._isFetchCycle()) this.PC = (this.PC + 1) & 0xfff;
    } else if (t === 3) {
      if (this.mcycle === 0) {
        this.maxMcycle = this._getInstMcycles(this.instOpcode);
      }
      this._executeStage(this.mcycle);
    } else if (t === 7) {
      this.bus = 0;
    }

    this.T = (this.T + 1) & 0x7;

    if (this.T === 0) {
      this.mcycle += 1;
      if (this.mcycle >= this.maxMcycle) {
        this.mcycle = 0;
        this.maxMcycle = 1;
      }
    }
  }

  stepInst() {
    const startCycle = this.cycle;
    while (true) {
      this.tick();
      if (this.stop) break;
      // mcycle回到0，并且至少跑满一个M-cycle（>=8tick）
      if (this.mcycle === 0 && this.cycle > startCycle + 7) break;
    }
  }

  dump() {
    return {
      cycle: this.cycle,
      T: this.T,
      mcycle: this.mcycle,
      maxMcycle: this.maxMcycle,
      PC: this.PC.toString(16).padStart(3, '0'),
      instPC: this.instPC.toString(16).padStart(3, '0'),
      opcode: this.instOpcode.toString(16),
      operandBuf: [...this.operandBuf],
      A: this.A,
      C: this.C,
      bus: this.bus,
      addr: this.addr.toString(16),
      reg: Array.from(this.reg),
      ramChip: this.memory.chip,
      ramBank: this.memory.bank
    }
  }
}

// 测试 JUN 0xF12 (0x3F,0x12)，目标地址放 HLT
const cpu = new Intel4004();
const rom = new Uint8Array(0xF13);
rom[0] = 0x3F;
rom[1] = 0x12;
rom[0xF12] = 0xFF;
cpu.loadRom(rom);

console.log("===== JUN 时序逐tick =====");
for (let i = 0; i < 30 && !cpu.stop; i++) {
  cpu.tick();
  const d = cpu.dump();
  console.log(`cycle ${d.cycle} | T${d.T} | mc=${d.mcycle}/${d.maxMcycle} | addr:${d.addr} bus:${d.bus.toString(16)} op:${d.opcode} buf:${d.operandBuf}`);
}
console.log("===== 停机状态 =====");
console.log(cpu.dump());

// 验证 JMS/BBL 返回地址：调用 0x010 子程序，BBL 后应回到 0x002 的 HLT
const cpu2 = new Intel4004();
const rom2 = new Uint8Array(0x20);
rom2[0] = 0x40; rom2[1] = 0x10;       // JMS 0x010
rom2[2] = 0xFF;                       // HLT
rom2[0x10] = 0xC2; rom2[0x11] = 0x0A; // LDM 0xA
rom2[0x12] = 0xB0;                    // BBL 0
cpu2.loadRom(rom2);
while (!cpu2.stop) cpu2.stepInst();
console.log("===== JMS/BBL 验证 =====");
console.log(cpu2.dump());

// 验证内存读写：LDM 5 -> WRM -> RDM -> HLT，A 应回到 5
const cpu3 = new Intel4004();
const rom3 = new Uint8Array([0xC5, 0xF0, 0xF8, 0xFF]);
cpu3.loadRom(rom3);
while (!cpu3.stop) cpu3.stepInst();
console.log("===== RAM 读写验证 =====");
console.log(cpu3.dump());

// 验证硬盘：WRR 把 0xA、0xB 两个半字节写成字节 0xAB 存入扇区 0
const imgPath = path.join(__dirname, 'disk.img');
const cpu4 = new Intel4004();
cpu4.attachDisk(imgPath);
cpu4.loadRom(new Uint8Array([0xCA, 0xF1, 0xCB, 0xF1, 0xFF])); // LDM A, WRR, LDM B, WRR, HLT
while (!cpu4.stop) cpu4.stepInst();
console.log("===== 硬盘写入验证 =====");
console.log("缓存中扇区0字节0:", cpu4.disk.readByte(0, 0).toString(16));
console.log(".img 文件字节0:", fs.readFileSync(imgPath)[0].toString(16));

// 重新打开 .img，验证持久化后 RDR 能读回高半字节 0xA
const disk2 = new Disk();
disk2.open(imgPath);
console.log("重新加载 .img 字节0:", disk2.readByte(0, 0).toString(16));

const cpu5 = new Intel4004();
cpu5.attachDisk(imgPath);
cpu5.loadRom(new Uint8Array([0xF9, 0xFF])); // RDR, HLT
while (!cpu5.stop) cpu5.stepInst();
console.log("===== 硬盘读回验证 =====");
console.log("RDR 读到的 A:", cpu5.A.toString(16));
