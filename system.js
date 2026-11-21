const path = require('path');
const nodeFs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const http = require('http');
const readline = require('readline');
const { Intel4004 } = require('./4004');
const { Disk } = require('./disk');
const { FileSystem } = require('./fs');
const { Font } = require('./font');
const { Framebuffer } = require('./framebuffer');
const { Nano } = require('./nano');
const { SoundCard } = require('./sound');
const { Shell } = require('./shell');

const IMG_PATH = process.env.IMG_PATH || path.join(__dirname, 'disk.img');
const PROGRAM_SECTOR = 1;
const VNC = process.argv.includes('-vnc');

const fb = VNC ? new Framebuffer(new Font()) : null;
const sound = new SoundCard();
let frameDirty = true;
let playSound = null; // 由前端/终端层注入的发声函数

function out(text) {
  if (VNC) { fb.write(text); frameDirty = true; }
  else process.stdout.write(text);
}

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
function unescape(text) {
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', '0': '\0', '\\': '\\' };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) {
      const c = text[++i];
      if (map[c] !== undefined) { out += map[c]; continue; }
      if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        out += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
        continue;
      }
      out += c;
      continue;
    }
    out += text[i];
  }
  return out;
}

function printViaCpu(text) {
  for (const line of text.split('\n')) {
    if (line) {
      for (let i = 0; i < line.length; i += 7) {
        out(runEcho(line.slice(i, i + 7)));
      }
    }
    out('\n');
  }
}

let cwd = '/';
let rl = null;
let launchEditor = null; // 由前端/终端层注入的 nano 启动函数
let enteredEditor = false; // handle() 是否刚启动了全屏编辑器

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
  const { operands } = parseArgs(arg, '');
  const targets = operands.length ? operands : ['.'];
  const lines = [];
  for (const name of targets) {
    const target = normalizePath(name);
    const entries = fs.list(target);
    if (!entries) return `ls: ${target}: no such directory`;
    lines.push(entries.map(e => e.type === 'd' ? `${e.name}/` : e.name).join('  ') || '(empty)');
  }
  return lines.join('\n');
}

function cmdCd(arg) {
  const { operands } = parseArgs(arg, '');
  if (operands.length > 1) return 'cd: too many arguments';
  const target = normalizePath(operands[0]);
  if (fs.resolve(target) === null) return `cd: ${target}: no such directory`;
  cwd = target;
  if (rl) rl.setPrompt(`4004${cwd}> `);
  return null;
}

function cmdCat(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return usage('cat', 'cat <file>...');
  let result = '';
  for (const name of operands) {
    const content = fs.readFile(normalizePath(name));
    if (content === null) return `cat: ${name}: no such file`;
    result += content.replace(/[^\x20-\x7e\n]/g, '.');
  }
  return result;
}

const FS_ERR = {
  'no such file': 'No such file or directory',
  'no such directory': 'No such file or directory',
  'is a directory': 'Is a directory'
};
const fsErr = e => FS_ERR[e] || e.charAt(0).toUpperCase() + e.slice(1);

const usage = (name, syntax) => `${name}: missing operand\nusage: ${syntax}`;

// 仿 getopt：解析出选项集合与位置参数，-- 之后一律当位置参数
function parseArgs(s, allowed) {
  const opts = new Set();
  const operands = [];
  let endOpts = false;
  for (const tok of s.trim().split(/\s+/).filter(Boolean)) {
    if (!endOpts && tok === '--') { endOpts = true; continue; }
    if (!endOpts && tok.startsWith('-') && tok.length > 1) {
      let ok = true;
      for (const c of tok.slice(1)) {
        if (allowed.includes(c)) opts.add(c);
        else ok = false;
      }
      if (!ok) return { error: `invalid option -- '${tok.slice(1)}'` };
      continue;
    }
    operands.push(tok);
  }
  return { opts, operands };
}

function cmdMkdir(arg) {
  const { opts, operands, error } = parseArgs(arg, 'p');
  if (error) return `mkdir: ${error}`;
  if (!operands.length) return usage('mkdir', 'mkdir [-p] <dir>...');
  const errors = [];
  for (const name of operands) {
    const err = fs.mkdir(normalizePath(name), opts.has('p'));
    if (err) errors.push(`mkdir: cannot create directory '${name}': ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function cmdRm(arg) {
  const { opts, operands, error } = parseArgs(arg, 'rfR');
  if (error) return `rm: ${error}`;
  if (!operands.length) return usage('rm', 'rm [-rf] <file>...');
  const recursive = opts.has('r') || opts.has('R');
  const force = opts.has('f');
  const errors = [];
  for (const name of operands) {
    const err = fs.rm(normalizePath(name), recursive, force);
    if (err && !force) errors.push(`rm: cannot remove '${name}': ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function cmdCp(arg) {
  const { operands, error } = parseArgs(arg, '');
  if (error) return `cp: ${error}`;
  if (operands.length < 2) return usage('cp', 'cp <src>... <dst>');
  const dst = normalizePath(operands[operands.length - 1]);
  const dstStat = fs.stat(dst);
  if (operands.length > 2 && (!dstStat || dstStat.type !== 'd')) {
    return `cp: target '${operands[operands.length - 1]}': Not a directory`;
  }
  const errors = [];
  for (const src of operands.slice(0, -1)) {
    const err = fs.cp(normalizePath(src), dst);
    if (err) errors.push(`cp: ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function cmdMv(arg) {
  const { operands, error } = parseArgs(arg, '');
  if (error) return `mv: ${error}`;
  if (operands.length < 2) return usage('mv', 'mv <src>... <dst>');
  const dst = normalizePath(operands[operands.length - 1]);
  const dstStat = fs.stat(dst);
  if (operands.length > 2 && (!dstStat || dstStat.type !== 'd')) {
    return `mv: target '${operands[operands.length - 1]}': Not a directory`;
  }
  const errors = [];
  for (const src of operands.slice(0, -1)) {
    const err = fs.mv(normalizePath(src), dst);
    if (err) errors.push(`mv: ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function readLines(path) {
  const content = fs.readFile(path);
  if (content === null) return null;
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function cmdBeep(arg) {
  // Linux beep 风格：-f 频率 -l 时长(ms) -r 重复 -d 间隔(ms) -n 波形 -v 音量
  // 同时兼容位置参数：beep <freq> <ms> <wave>
  let freq = 440, ms = 200, repeat = 1, delayMs = 100, wave = 'square';
  let volume = null;
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break; }
    const opt = { '-f': 'f', '-l': 'l', '-r': 'r', '-d': 'd', '-n': 'n', '-v': 'v' }[t];
    if (opt && i + 1 < tokens.length) {
      const val = tokens[++i];
      if (opt === 'f') freq = parseFloat(val);
      else if (opt === 'l') ms = parseFloat(val);
      else if (opt === 'r') repeat = parseInt(val, 10);
      else if (opt === 'd') delayMs = parseFloat(val);
      else if (opt === 'n') wave = val;
      else if (opt === 'v') volume = parseFloat(val);
      continue;
    }
    if (t.startsWith('-f') && t.length > 2) { freq = parseFloat(t.slice(2)); continue; }
    if (t.startsWith('-l') && t.length > 2) { ms = parseFloat(t.slice(2)); continue; }
    if (t.startsWith('-') && t.length > 1) return `beep: invalid option '${t}'`;
    positional.push(t);
  }
  if (positional[0]) freq = parseFloat(positional[0]);
  if (positional[1]) ms = parseFloat(positional[1]);
  if (positional[2]) wave = positional[2];
  if (isNaN(freq) || freq <= 0) return `beep: invalid frequency '${freq}'`;
  if (isNaN(ms) || ms <= 0) return `beep: invalid duration '${ms}'`;
  if (isNaN(repeat) || repeat < 1 || repeat > 20) return `beep: invalid repeat '${repeat}'`;
  if (!['square', 'sine', 'triangle'].includes(wave)) return `beep: unknown waveform '${wave}'`;
  if (volume !== null) {
    if (isNaN(volume) || volume < 0 || volume > 255) return `beep: invalid volume '${volume}'`;
    sound.setVolume(volume);
  }
  if (!sound.enabled) return 'beep: sound card disabled';

  const toneMs = Math.min(ms, 5000);
  const toneData = sound.tone(freq, toneMs, wave);
  // 重复：把静音间隔插在每段之间
  let data = toneData;
  if (repeat > 1) {
    const gap = new Uint8Array(Math.max(0, Math.floor(sound.sampleRate * delayMs / 1000))).fill(128);
    const parts = [];
    for (let r = 0; r < repeat; r++) { if (r) parts.push(gap); parts.push(toneData); }
    data = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let off = 0;
    for (const p of parts) { data.set(p, off); off += p.length; }
  }
  if (playSound) playSound(data, sound.sampleRate);
  return null;
}

function cmdSleep(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return usage('sleep', 'sleep <sec>');
  const sec = parseFloat(operands[0]);
  if (isNaN(sec) || sec < 0) return `sleep: invalid time interval '${operands[0]}'`;
  const ms = Math.min(sec * 1000, 5000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return null;
}

function cmdHexdump(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return usage('hexdump', 'hexdump <file>');
  const bytes = fs.readBytes(normalizePath(operands[0]));
  if (bytes === null) return `hexdump: ${operands[0]}: No such file`;
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const hex = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = chunk.map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  lines.push(`${bytes.length.toString(16).padStart(8, '0')}`);
  return lines.join('\n');
}

function cmdStrings(arg) {
  const { operands } = parseArgs(arg, 'n');
  let min = 4;
  const m = arg.match(/(?:^|\s)-n\s*(\d+)/);
  if (m) min = parseInt(m[1], 10);
  const file = operands[operands.length - 1];
  if (!file) return usage('strings', 'strings [-n N] <file>');
  const bytes = fs.readBytes(normalizePath(file));
  if (bytes === null) return `strings: ${file}: No such file`;
  const out = [];
  let cur = '';
  for (const b of bytes) {
    if (b >= 32 && b <= 126) cur += String.fromCharCode(b);
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  return out.join('\n');
}

function cmdHeadTail(arg, tail) {
  const name = tail ? 'tail' : 'head';
  let count = 10;
  let rest = arg.trim();
  const mn = rest.match(/^-n\s*(\d+)\s*/);
  if (mn) { count = parseInt(mn[1], 10); rest = rest.slice(mn[0].length); }
  else {
    const md = rest.match(/^-(\d+)\s*/);
    if (md) { count = parseInt(md[1], 10); rest = rest.slice(md[0].length); }
  }
  const file = rest.split(/\s+/)[0];
  if (!file) return usage(name, `${name} [-n N] <file>`);
  const lines = readLines(normalizePath(file));
  if (lines === null) return `${name}: cannot open '${file}'`;
  return (tail ? lines.slice(-count) : lines.slice(0, count)).join('\n');
}

function cmdWc(arg) {
  const { opts, operands } = parseArgs(arg, 'lwc');
  if (!operands.length) return usage('wc', 'wc [-lwc] <file>...');
  const lines = [];
  for (const name of operands) {
    const content = fs.readFile(normalizePath(name));
    if (content === null) return `wc: ${name}: No such file`;
    const ls = readLines(normalizePath(name));
    const nLines = ls.length;
    const nWords = content.trim() ? content.trim().split(/\s+/).length : 0;
    const nBytes = content.length;
    const cols = [];
    if (opts.size === 0 || opts.has('l')) cols.push(String(nLines).padStart(6));
    if (opts.size === 0 || opts.has('w')) cols.push(String(nWords).padStart(6));
    if (opts.size === 0 || opts.has('c')) cols.push(String(nBytes).padStart(6));
    lines.push(cols.join(' ') + ' ' + name);
  }
  return lines.join('\n');
}

function cmdGrep(arg) {
  const { opts, operands } = parseArgs(arg, 'iv');
  if (operands.length < 2) return usage('grep', 'grep [-iv] <pat> <file>');
  const pattern = operands[0];
  const lines = readLines(normalizePath(operands[1]));
  if (lines === null) return `grep: ${operands[1]}: No such file`;
  const re = new RegExp(pattern, opts.has('i') ? 'i' : '');
  return lines.filter(l => re.test(l) !== opts.has('v')).join('\n');
}

function cmdSort(arg) {
  const { opts, operands } = parseArgs(arg, 'r');
  if (!operands.length) return usage('sort', 'sort [-r] <file>');
  const lines = readLines(normalizePath(operands[0]));
  if (lines === null) return `sort: ${operands[0]}: No such file`;
  lines.sort();
  if (opts.has('r')) lines.reverse();
  return lines.join('\n');
}

function cmdFind(arg) {
  const { operands } = parseArgs(arg, '');
  const start = operands.length ? normalizePath(operands[0]) : '.';
  const target = normalizePath(start);
  if (fs.stat(target) === null) return `find: '${operands[0] || start}': No such file or directory`;
  const nodes = fs.walk(target);
  const lines = [target];
  for (const n of nodes) lines.push(n.path);
  return lines.join('\n');
}

function cmdTree(arg) {
  const { operands } = parseArgs(arg, '');
  const target = normalizePath(operands[0] || '.');
  if (fs.stat(target) === null) return `tree: '${operands[0] || '.'}': No such directory`;
  const lines = [target === '/' ? '/' : target.split('/').pop()];
  const nodes = fs.walk(target);
  let dirs = 0, files = 0;
  for (const n of nodes) {
    const last = n.depth === 0;
    lines.push('    '.repeat(n.depth) + (last ? '' : '|-- ') + n.entry.name + (n.entry.type === 'd' ? '/' : ''));
    if (n.entry.type === 'd') dirs++; else files++;
  }
  lines.push('');
  lines.push(`${dirs} directories, ${files} files`);
  return lines.join('\n');
}

function cmdDu(arg) {
  const { operands } = parseArgs(arg, '');
  const target = normalizePath(operands[0] || '.');
  if (fs.stat(target) === null) return `du: '${operands[0] || '.'}': No such directory`;
  const nodes = fs.walk(target);
  let total = 0;
  const lines = [];
  for (const n of nodes) {
    if (n.entry.type === 'f') {
      const size = fs.fileSize(n.path);
      total += size;
      lines.push(`${String(size).padStart(5)}  ${n.path}`);
    }
  }
  lines.push(`${String(total).padStart(5)}  ${target}`);
  return lines.join('\n');
}

function fmtTime(t) {
  if (!t) return 'Jan  1 00:00';
  const d = new Date(t * 1000);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${mon} ${String(d.getUTCDate()).padStart(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function cmdTouch(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return usage('touch', 'touch <file>...');
  const errors = [];
  for (const name of operands) {
    const err = fs.touch(normalizePath(name));
    if (err) errors.push(`touch: cannot touch '${name}': ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function cmdStat(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return usage('stat', 'stat <file>...');
  const lines = [];
  for (const name of operands) {
    const p = normalizePath(name);
    const st = fs.stat(p);
    if (!st) return `stat: cannot stat '${name}': No such file or directory`;
    const size = st.type === 'f' ? fs.fileSize(p) : 0;
    lines.push([
      `  File: ${name}`,
      `  Type: ${st.type === 'd' ? 'directory' : 'regular file'}`,
      `  Size: ${size}`,
      `  Inode: sector ${st.sector}`,
      `Modify: ${fmtTime(st.mtime)}`
    ].join('\n'));
  }
  return lines.join('\n');
}

function cmdDf() {
  const u = fs.usage();
  const pct = Math.round(u.used / u.total * 100);
  return [
    'Filesystem   Sectors    Used   Free Use% Mounted on',
    `/dev/ram0   ${String(u.total).padStart(7)} ${String(u.used).padStart(7)} ${String(u.free).padStart(6)} ${String(pct).padStart(3)}% /`,
    `            (${u.total * u.sectorSize} bytes total, ${u.sectorSize} bytes/sector)`
  ].join('\n');
}

function cmdFree() {
  const u = cpu.memory.ramUsage();
  return [
    '          total   used   free',
    `4002 RAM  ${String(u.total).padStart(6)} ${String(u.used).padStart(6)} ${String(u.free).padStart(6)}`,
    `          (nibbles; ${u.total / 2} bytes total)`
  ].join('\n');
}

const HELP_TEXT = [
  '4004 shell - available commands',
  '',
  '  FILE SYSTEM',
  '    ls [path]              list directory (default: .)',
  '    cd [path]              change directory (default: /home)',
  '    pwd                    print working directory',
  '    cat <file>...          print file contents',
  '    touch <file>...        create files / update mtime',
  '    stat <file>...         show file metadata',
  '    mkdir [-p] <dir>...    create directories',
  '    rm [-rf] <file>...     remove files ( -r: dirs, -f: force )',
  '    cp <src>... <dst>      copy files to file/directory',
  '    mv <src>... <dst>      move/rename files',
  '    find [path]            list all descendants',
  '    tree [path]            print directory tree',
  '    du [path]              disk usage by file',
  '    df                     filesystem free space',
  '    free                   RAM usage',
  '',
  '  TEXT',
  '    nano [file]            fullscreen editor',
  '    echo <text>            print text (supports \\n \\t \\xHH)',
  '    head [-n N] <file>     first N lines (default 10)',
  '    tail [-n N] <file>     last N lines (default 10)',
  '    wc [-lwc] <file>...    count lines / words / bytes',
  '    grep [-iv] <pat> <file>   search lines ( -i: ignore case, -v: invert )',
  '    sort [-r] <file>       sort lines ( -r: reverse )',
  '    hexdump <file>         hex + ASCII dump',
  '    strings [-n N] <file>  printable strings (default N=4)',
  '',
  '  SOUND / MISC',
  '    beep [-f Hz] [-l ms] [-r n] [-d ms] [-n wave] [-v vol]',
  '                           play tone (wave: square|sine|triangle)',
  '    sleep <sec>            wait for N seconds',
  '    clear                  clear screen',
  '    help                   show this help',
  '    exit                   leave the shell',
  '',
  '  SHELL',
  '    cmd1 | cmd2            pipe stdout to stdin',
  '    a && b / a || b        conditional execution',
  '    a ; b                  sequence',
  '    VAR=value  $VAR  $?    variables',
  '    for v in a b; do ...; done',
  '    if cmd; then ...; else ...; fi',
  '    while cmd; do ...; done',
  '    cmd > file / >> file / < file   redirection',
  '    true  false  test <expr>  [ <expr> ]',
  '    # comment                 comment runs to end of line',
  '    Shift+PgUp / Shift+PgDn   scroll back / forward (VNC)',
  '',
  '  <required>  [optional]  ...  one or more'
].join('\n');

// 把 stdin 写入隐藏文件，供下游命令通过 - 读取
const PIPE_FILE = '/.pipe';
function feedStdin(input) {
  fs.writeFile(PIPE_FILE, input === undefined ? '' : input);
}

// 命令分发：返回 { code, output }
function dispatch(ctx, argv) {
  const name = argv[0];
  const rest = argv.slice(1).join(' ');

  if (name === 'true') return { code: 0, output: '' };
  if (name === 'false') return { code: 1, output: '' };
  if (name === ':') return { code: 0, output: '' };
  if (name === 'test' || name === '[') return testCommand(argv.slice(1));
  if (name === 'write') {
    const file = argv[1];
    const append = argv[argv.length - 1] === 'append';
    const content = argv.slice(2, append ? -1 : undefined).join(' ');
    const prev = append && fs.stat(normalizePath(file)) ? fs.readFile(normalizePath(file)) : '';
    const err = fs.writeFile(normalizePath(file), prev + content);
    return err ? { code: 1, output: `${file}: ${err}\n` } : { code: 0, output: '' };
  }
  if (name === 'exit' || name === 'quit') {
    return { code: 0, output: '', exit: true };
  }
  if (name === 'help') return { code: 0, output: HELP_TEXT + '\n' };
  if (name === 'clear') return { code: 0, output: '\x1b[2J\x1b[H' };
  if (name === 'nano') {
    const { operands, error } = parseArgs(rest, '');
    if (error) return { code: 1, output: `nano: ${error}\n` };
    if (launchEditor) { enteredEditor = true; launchEditor(operands[0] || ''); }
    else return { code: 1, output: 'nano: not available in this mode\n' };
    return { code: 0, output: '' };
  }

  // 管道输入：把 - 参数替换为隐藏文件；文本过滤器缺文件参数时自动补上
  const stdin = ctx.stdin;
  const hasInput = stdin !== undefined && stdin !== '';
  if (hasInput) feedStdin(stdin);
  let argv2 = rest.trim().split(/\s+/).filter(Boolean).map(s => hasInput && s === '-' ? PIPE_FILE : s);
  if (hasInput && ['grep', 'sort', 'wc', 'head', 'tail', 'hexdump', 'strings', 'cat'].includes(name)) {
    // 数非选项参数（跳过 -x 和数字选项值）
    const optionNames = { wc: ['-l', '-w', '-c'], grep: ['-i', '-v'], sort: ['-r'], head: [], tail: [] };
    const opts = optionNames[name] || [];
    const nonOpts = argv2.filter((s, i) => {
      if (opts.includes(s)) return false;
      if ((name === 'head' || name === 'tail') && (s === '-n' || /^\d+$/.test(s))) return false;
      if (name === 'strings' && /^\d+$/.test(s) && argv2[i - 1] === '-n') return false;
      return true;
    });
    const need = name === 'grep' ? 2 : 1;
    if (nonOpts.length < need) argv2.push(PIPE_FILE);
  }
  const arg = argv2.join(' ');

  let output = null;
  switch (name) {
    case 'echo': output = arg ? unescape(arg) + '\n' : '\n'; break;
    case 'ls': output = cmdLs(arg.trim()) + '\n'; break;
    case 'cd': { const e = cmdCd(arg.trim()); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'pwd': output = cwd + '\n'; break;
    case 'cat': output = cmdCat(arg.trim()); break;
    case 'mkdir': { const e = cmdMkdir(arg); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'rm': { const e = cmdRm(arg); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'cp': { const e = cmdCp(arg); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'mv': { const e = cmdMv(arg); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'touch': { const e = cmdTouch(arg); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'stat': output = cmdStat(arg.trim()) + '\n'; break;
    case 'find': output = cmdFind(arg.trim()) + '\n'; break;
    case 'tree': output = cmdTree(arg.trim()) + '\n'; break;
    case 'du': output = cmdDu(arg.trim()) + '\n'; break;
    case 'head': output = cmdHeadTail(arg.trim(), false) + '\n'; break;
    case 'tail': output = cmdHeadTail(arg.trim(), true) + '\n'; break;
    case 'wc': output = cmdWc(arg.trim()) + '\n'; break;
    case 'grep': output = cmdGrep(arg.trim()) + '\n'; break;
    case 'sort': output = cmdSort(arg.trim()) + '\n'; break;
    case 'hexdump': output = cmdHexdump(arg.trim()) + '\n'; break;
    case 'strings': output = cmdStrings(arg.trim()) + '\n'; break;
    case 'sleep': { const e = cmdSleep(arg.trim()); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'beep': { const e = cmdBeep(arg.trim()); if (e) return { code: 1, output: e + '\n' }; break; }
    case 'df': output = cmdDf() + '\n'; break;
    case 'free': output = cmdFree() + '\n'; break;
    default: return { code: 127, output: `${name}: command not found\n` };
  }
  if (output === null) output = '';
  if (hasInput) output = output.split(PIPE_FILE).join('-');
  const isErr = /^(ls|cd|cat|mkdir|rm|cp|mv|touch|stat|find|tree|du|head|tail|wc|grep|sort|hexdump|strings|sleep|beep):/.test(output);
  return { code: isErr ? 1 : 0, output };
}

// test / [ 内建
function testCommand(args) {
  if (args[0] === '[' && args[args.length - 1] === ']') args = args.slice(1, -1);
  if (!args.length) return { code: 1, output: '' };
  if (args[0] === '-n' && args[1] !== undefined) return { code: args[1].length > 0 ? 0 : 1, output: '' };
  if (args[0] === '-z' && args[1] !== undefined) return { code: args[1].length === 0 ? 0 : 1, output: '' };
  if (args.length >= 3 && ['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(args[1])) {
    const a = args[0], b = args[2], op = args[1];
    let ok = false;
    if (op === '=' || op === '==') ok = a === b;
    else if (op === '!=') ok = a !== b;
    else {
      const na = Number(a), nb = Number(b);
      if (op === '-eq') ok = na === nb;
      else if (op === '-ne') ok = na !== nb;
      else if (op === '-lt') ok = na < nb;
      else if (op === '-le') ok = na <= nb;
      else if (op === '-gt') ok = na > nb;
      else if (op === '-ge') ok = na >= nb;
    }
    return { code: ok ? 0 : 1, output: '' };
  }
  // 单参数：非空即真；-f/-d 检查文件
  if (args[0] === '-f' && args[1]) {
    const st = fs.stat(normalizePath(args[1]));
    return { code: st && st.type === 'f' ? 0 : 1, output: '' };
  }
  if (args[0] === '-d' && args[1]) {
    const st = fs.stat(normalizePath(args[1]));
    return { code: st && st.type === 'd' ? 0 : 1, output: '' };
  }
  return { code: args[0] && Number(args[0]) !== 0 ? 0 : 1, output: '' };
}

const shell = new Shell(dispatch);

function handle(line) {
  const cmd = line.trim();
  if (!cmd) return true;
  const result = shell.run(cmd, {});
  if (result.output) out(result.output);
  if (result.exit) return false;
  return true;
}


const BANNER = '4004 system - programs and filesystem in disk.img\n';

if (VNC) {
  const clients = new Set();
  const soundClients = new Set();
  let inputBuf = '';
  let drawnLen = 0; // 当前行已绘制的输入长度（不含提示符）
  let cursorPos = 0; // 输入行内光标位置
  const history = [];
  let histIdx = 0;
  let editor = null; // nano 实例，非 null 时接管所有按键

  function promptStr() { return `4004${cwd}> `; }

  function broadcast() {
    const frame = fb.frame();
    frame.sound = sound.status();
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of clients) res.write(payload);
    frameDirty = false;
  }

  playSound = (data, rate) => {
    const payload = `data: ${JSON.stringify({ pcm: Buffer.from(data).toString('base64'), rate })}\n\n`;
    for (const res of soundClients) res.write(payload);
  };

  function redrawInput() {
    const prompt = promptStr();
    const clearLen = Math.min(prompt.length + Math.max(drawnLen, inputBuf.length), fb.cols - 1);
    const row = fb.cy;
    fb.write('\r' + ' '.repeat(clearLen) + '\r' + prompt + inputBuf);
    fb.goto(Math.min(prompt.length + cursorPos, fb.cols - 1), row);
    drawnLen = inputBuf.length;
    frameDirty = true;
  }

  function submitLine() {
    const cmd = inputBuf;
    fb.write('\n');
    inputBuf = '';
    if (cmd.trim()) { history.push(cmd); histIdx = history.length; }
    drawnLen = 0;
    cursorPos = 0;
    const keep = handle(cmd);
    if (!keep) fb.write('[session closed]\n');
    else if (!enteredEditor) fb.write(promptStr());
    enteredEditor = false;
    frameDirty = true;
  }

  function renderEditor() {
    fb.setCells(editor.render());
    fb.goto(editor.col, editor.row - editor.top + 1);
    frameDirty = true;
  }

  function startEditor(filename) {
    const target = normalizePath(filename);
    const existing = fs.stat(target);
    const content = existing && existing.type === 'f' ? fs.readFile(target) : '';
    editor = new Nano(fs, cwd, filename, content);
    renderEditor();
    broadcast();
  }
  launchEditor = startEditor;

  function onKey(key) {
    if (editor) {
      const result = editor.onKey(key);
      if (result.exit) {
        editor = null;
        fb.clear();
        fb.write(promptStr());
      } else {
        renderEditor();
      }
      frameDirty = true;
      return;
    }
    if (key === 'PageUp' || key === 'PageDown') {
      if (key === 'PageUp') fb.scrollUp(1); else fb.scrollDown(1);
      frameDirty = true;
      return;
    }
    if (fb.scrollPos > 0) { fb.resetScroll(); frameDirty = true; }
    if (key === 'Enter') { submitLine(); return; }
    if (key === 'Backspace') {
      if (cursorPos > 0) {
        inputBuf = inputBuf.slice(0, cursorPos - 1) + inputBuf.slice(cursorPos);
        cursorPos--;
        redrawInput();
      }
      return;
    }
    if (key === 'Delete') {
      if (cursorPos < inputBuf.length) {
        inputBuf = inputBuf.slice(0, cursorPos) + inputBuf.slice(cursorPos + 1);
        redrawInput();
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (key === 'ArrowLeft' && cursorPos > 0) cursorPos--;
      else if (key === 'ArrowRight' && cursorPos < inputBuf.length) cursorPos++;
      redrawInput();
      return;
    }
    if (key === 'Home') { cursorPos = 0; redrawInput(); return; }
    if (key === 'End') { cursorPos = inputBuf.length; redrawInput(); return; }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (!history.length) return;
      histIdx = Math.max(0, Math.min(history.length, histIdx + (key === 'ArrowUp' ? -1 : 1)));
      inputBuf = history[histIdx] || '';
      cursorPos = inputBuf.length;
      redrawInput();
      return;
    }
    if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
      inputBuf = inputBuf.slice(0, cursorPos) + key + inputBuf.slice(cursorPos);
      cursorPos++;
      redrawInput();
    }
  }

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(nodeFs.readFileSync(path.join(__dirname, 'crt.html')));
      return;
    }
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      clients.add(res);
      const frame = fb.frame();
      frame.sound = sound.status();
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && pathname === '/sound') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      soundClients.add(res);
      req.on('close', () => soundClients.delete(res));
      return;
    }
    if (req.method === 'POST' && pathname === '/key') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { onKey(JSON.parse(body).key || ''); } catch (e) { /* ignore */ }
        res.writeHead(204);
        res.end();
        if (frameDirty) broadcast();
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/paste') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const text = JSON.parse(body).text || '';
          for (const ch of text) {
            onKey(ch === '\n' ? 'Enter' : ch === '\t' ? 'Tab' : ch);
          }
        } catch (e) { /* ignore */ }
        res.writeHead(204);
        res.end();
        if (frameDirty) broadcast();
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  fb.write(BANNER + promptStr());
  server.listen(15900, () => console.log('VNC terminal on http://localhost:15900'));
  setInterval(() => {
    fb.cursorOn = !fb.cursorOn;
    frameDirty = true;
    if (frameDirty) broadcast();
  }, 530);
} else {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let cliEditor = null;

  // CLI 发声：生成 WAV 临时文件交给系统播放器；纯 tty 无音频则静默提示
  const PLAYERS = [
    ['aplay', ['-q']],
    ['paplay', []],
    ['afplay', []]
  ];
  function findPlayer() {
    for (const [bin, args] of PLAYERS) {
      try { execFileSync('which', [bin], { stdio: 'ignore' }); return { bin, args }; }
      catch (e) { /* not found */ }
    }
    return null;
  }
  playSound = (data, rate) => {
    const player = findPlayer();
    if (!player) return; // 纯 tty 无音频设备，保持静默
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate, 28);
    header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
    header.write('data', 36); header.writeUInt32LE(data.length, 40);
    const wav = Buffer.concat([header, Buffer.from(data)]);
    const tmp = path.join(os.tmpdir(), `beep-${process.pid}.wav`);
    try {
      nodeFs.writeFileSync(tmp, wav);
      execFileSync(player.bin, [...player.args, tmp], { stdio: 'ignore', timeout: 10000 });
    } catch (e) { /* 播放失败则静默 */ }
    finally { try { nodeFs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
  };

  const KEYMAP = {
    enter: 'Enter', backspace: 'Backspace', delete: 'Delete',
    left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
    home: 'Home', end: 'End', escape: 'Escape', tab: 'Tab', f10: 'F10'
  };
  function keyName(str, key) {
    if (key.ctrl && key.name) return 'Ctrl+' + key.name.toUpperCase();
    if (KEYMAP[key.name]) return KEYMAP[key.name];
    return str || '';
  }
  function renderCliEditor() {
    out('\x1b[2J\x1b[H');
    const grid = cliEditor.render();
    out(grid.join('\r\n'));
    out(`\x1b[${cliEditor.row - cliEditor.top + 2};${cliEditor.col + 1}H`);
  }
  function exitCliEditor() {
    cliEditor = null;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    rl.resume();
    out('\r\n' + promptStr());
  }

  launchEditor = (filename) => {
    const target = normalizePath(filename);
    const existing = fs.stat(target);
    const content = existing && existing.type === 'f' ? fs.readFile(target) : '';
    cliEditor = new Nano(fs, cwd, filename, content);
    rl.pause();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    renderCliEditor();
  };

  out(BANNER);
  rl.setPrompt(`4004${cwd}> `);
  rl.prompt();
  rl.on('line', (line) => {
    const keep = handle(line);
    if (keep === false) { rl.close(); return; }
    if (!enteredEditor) rl.prompt();
    enteredEditor = false;
  });
  rl.on('close', () => out('\n'));
  process.stdin.on('keypress', (str, key) => {
    if (!cliEditor || !key) return;
    const name = keyName(str, key);
    const result = cliEditor.onKey(name);
    if (result.exit) exitCliEditor();
    else renderCliEditor();
  });
}
