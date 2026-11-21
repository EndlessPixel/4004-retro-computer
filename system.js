const path = require('path');
const readline = require('readline');
const { Intel4004 } = require('./4004');
const { Disk } = require('./disk');
const { FileSystem } = require('./fs');

const IMG_PATH = path.join(__dirname, 'disk.img');
const PROGRAM_SECTOR = 1;

// echo 程序（存于 img 扇区 1）：
//   RDM / XCH 1 / INC 0 / loop: RDM / WRR / INC 0 / ISZ 1,loop / HLT
// RAM[0] 存循环计数器初值，RAM[1..] 为待输出半字节
const ECHO_PROGRAM = [0xF8, 0xA1, 0x50, 0xF8, 0xF1, 0x50, 0x61, 0x03, 0xFF];

const installer = new Disk();
installer.open(IMG_PATH);
if (installer.readByte(PROGRAM_SECTOR, 0) !== ECHO_PROGRAM[0]) {
  ECHO_PROGRAM.forEach((byte, i) => installer.writeByte(PROGRAM_SECTOR, i, byte));
}

const fs = new FileSystem(installer);
if (!fs.isFormatted()) fs.format();

const cpu = new Intel4004();
cpu.attachDisk(IMG_PATH);

function programFromImage() {
  const bytes = [];
  for (let i = 0; i < ECHO_PROGRAM.length; i++) bytes.push(cpu.disk.readByte(PROGRAM_SECTOR, i));
  return bytes;
}

function runEcho(text) {
  const nibbles = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0) & 0xff;
    nibbles.push((code >> 4) & 0xf, code & 0xf);
  }
  const data = nibbles.slice(0, 14); // RAM 单 bank 容量限制：最多 7 字符
  if (data.length === 0) return '';

  cpu.memory.writeRam(0, (16 - data.length) & 0xf);
  data.forEach((n, i) => cpu.memory.writeRam(i + 1, n));

  cpu.loadRom(programFromImage());
  cpu.selectDevice('terminal');
  cpu.terminal.reset();
  while (!cpu.stop) cpu.stepInst();
  return cpu.terminal.drainOutput();
}

// 长文本分块，每块都真正经 CPU 输出
function printViaCpu(text) {
  for (const line of text.split('\n')) {
    if (line) {
      for (let i = 0; i < line.length; i += 7) {
        process.stdout.write(runEcho(line.slice(i, i + 7)));
      }
    }
    process.stdout.write('\n');
  }
}

let cwd = '/';

function normalizePath(target) {
  if (!target || target === '~') return '/home';
  let p = target;
  if (p.startsWith('~/')) p = `/home/${p.slice(2)}`;
  else if (!p.startsWith('/')) p = `${cwd === '/' ? '' : cwd}/${p}`;
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return '/' + parts.join('/');
}

function cmdLs(arg) {
  const target = normalizePath(arg || '.');
  const entries = fs.list(target);
  if (!entries) return `ls: ${target}: no such directory`;
  return entries.map(e => e.type === 'd' ? `${e.name}/` : e.name).join('  ') || '(empty)';
}

function cmdCd(arg) {
  const target = normalizePath(arg);
  if (fs.resolve(target) === null) return `cd: ${target}: no such directory`;
  cwd = target;
  rl.setPrompt(`4004${cwd}> `);
  return null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function handle(line) {
  const cmd = line.trim();
  if (!cmd) return;
  if (cmd === 'exit' || cmd === 'quit') {
    rl.close();
    return false;
  }
  if (cmd === 'help') {
    console.log('commands: echo <text> | ls [path] | cd [path] | pwd | exit');
  } else if (cmd === 'echo') {
    console.log('');
  } else if (cmd.startsWith('echo ')) {
    printViaCpu(cmd.slice(5));
  } else if (cmd === 'ls' || cmd.startsWith('ls ')) {
    printViaCpu(cmdLs(cmd.slice(2).trim()));
  } else if (cmd === 'cd' || cmd.startsWith('cd ')) {
    const err = cmdCd(cmd.slice(2).trim());
    if (err) printViaCpu(err);
  } else {
    console.log(`unknown command: ${cmd.split(/\s+/)[0]}`);
  }
  return true;
}

console.log('4004 system - programs and filesystem in disk.img');
rl.setPrompt(`4004${cwd}> `);
rl.prompt();
rl.on('line', (line) => {
  if (handle(line) !== false) rl.prompt();
});
rl.on('close', () => process.stdout.write('\n'));
