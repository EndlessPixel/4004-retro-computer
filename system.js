const path = require('path');
const nodeFs = require('fs');
const http = require('http');
const readline = require('readline');
const { Intel4004 } = require('./4004');
const { Disk } = require('./disk');
const { FileSystem } = require('./fs');
const { Font } = require('./font');
const { Framebuffer } = require('./framebuffer');
const { Nano } = require('./nano');

const IMG_PATH = process.env.IMG_PATH || path.join(__dirname, 'disk.img');
const PROGRAM_SECTOR = 1;
const VNC = process.argv.includes('-vnc');

const fb = VNC ? new Framebuffer(new Font()) : null;
let frameDirty = true;

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
  if (!operands.length) return 'cat: missing file operand';
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
  if (!operands.length) return 'mkdir: missing operand';
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
  if (!operands.length) return 'rm: missing operand';
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
  if (operands.length < 2) return 'cp: missing destination file operand';
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
  if (operands.length < 2) return 'mv: missing destination file operand';
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

function fmtTime(t) {
  if (!t) return 'Jan  1 00:00';
  const d = new Date(t * 1000);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${mon} ${String(d.getUTCDate()).padStart(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function cmdTouch(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return 'touch: missing file operand';
  const errors = [];
  for (const name of operands) {
    const err = fs.touch(normalizePath(name));
    if (err) errors.push(`touch: cannot touch '${name}': ${fsErr(err)}`);
  }
  return errors.join('\n') || null;
}

function cmdStat(arg) {
  const { operands } = parseArgs(arg, '');
  if (!operands.length) return 'stat: missing operand';
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

function handle(line) {
  const cmd = line.trim();
  if (!cmd) return true;
  if (cmd === 'exit' || cmd === 'quit') {
    if (rl) rl.close();
    return false;
  }
  if (cmd === 'help') {
    out('commands: echo <text> | ls [path] | cd [path] | pwd | cat <file> | mkdir <dir> | rm <file> | cp <src> <dst> | mv <src> <dst> | nano [file] | touch <file> | stat <file> | df | free | clear | exit\n');
  } else if (cmd === 'clear') {
    out('\x1b[2J\x1b[H');
  } else if (cmd === 'echo') {
    out('\n');
  } else if (cmd.startsWith('echo ')) {
    printViaCpu(unescape(cmd.slice(5)));
  } else if (cmd === 'ls' || cmd.startsWith('ls ')) {
    printViaCpu(cmdLs(cmd.slice(2).trim()));
  } else if (cmd === 'cd' || cmd.startsWith('cd ')) {
    const err = cmdCd(cmd.slice(2).trim());
    if (err) printViaCpu(err);
  } else if (cmd === 'pwd') {
    printViaCpu(cwd);
  } else if (cmd === 'cat' || cmd.startsWith('cat ')) {
    printViaCpu(cmdCat(cmd.slice(3).trim()));
  } else if (cmd === 'mkdir' || cmd.startsWith('mkdir ')) {
    const err = cmdMkdir(cmd.slice(5));
    if (err) printViaCpu(err);
  } else if (cmd === 'rm' || cmd.startsWith('rm ')) {
    const err = cmdRm(cmd.slice(2));
    if (err) printViaCpu(err);
  } else if (cmd === 'cp' || cmd.startsWith('cp ')) {
    const err = cmdCp(cmd.slice(2));
    if (err) printViaCpu(err);
  } else if (cmd === 'mv' || cmd.startsWith('mv ')) {
    const err = cmdMv(cmd.slice(2));
    if (err) printViaCpu(err);
  } else if (cmd === 'nano' || cmd.startsWith('nano ')) {
    const { operands, error } = parseArgs(cmd.slice(4), '');
    if (error) out(`nano: ${error}\n`);
    else if (launchEditor) { enteredEditor = true; launchEditor(operands[0] || ''); }
    else out('nano: not available in this mode\n');
  } else if (cmd === 'touch' || cmd.startsWith('touch ')) {
    const err = cmdTouch(cmd.slice(5));
    if (err) printViaCpu(err);
  } else if (cmd === 'stat' || cmd.startsWith('stat ')) {
    printViaCpu(cmdStat(cmd.slice(4)));
  } else if (cmd === 'df') {
    printViaCpu(cmdDf());
  } else if (cmd === 'free') {
    printViaCpu(cmdFree());
  } else {
    out(`unknown command: ${cmd.split(/\s+/)[0]}\n`);
  }
  return true;
}

const BANNER = '4004 system - programs and filesystem in disk.img\n';

if (VNC) {
  const clients = new Set();
  let inputBuf = '';
  let drawnLen = 0; // 当前行已绘制的输入长度（不含提示符）
  let cursorPos = 0; // 输入行内光标位置
  const history = [];
  let histIdx = 0;
  let editor = null; // nano 实例，非 null 时接管所有按键

  function promptStr() { return `4004${cwd}> `; }

  function broadcast() {
    const payload = `data: ${JSON.stringify(fb.frame())}\n\n`;
    for (const res of clients) res.write(payload);
    frameDirty = false;
  }

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
      res.write(`data: ${JSON.stringify(fb.frame())}\n\n`);
      req.on('close', () => clients.delete(res));
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
    if (keep !== false && !enteredEditor) rl.prompt();
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
