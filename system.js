const path = require('path');
const nodeFs = require('fs');
const http = require('http');
const readline = require('readline');
const { Intel4004 } = require('./4004');
const { Disk } = require('./disk');
const { FileSystem } = require('./fs');
const { Font } = require('./font');
const { Framebuffer } = require('./framebuffer');

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

function handle(line) {
  const cmd = line.trim();
  if (!cmd) return true;
  if (cmd === 'exit' || cmd === 'quit') {
    if (rl) rl.close();
    return false;
  }
  if (cmd === 'help') {
    out('commands: echo <text> | ls [path] | cd [path] | pwd | cat <file> | mkdir <dir> | rm <file> | cp <src> <dst> | mv <src> <dst> | clear | exit\n');
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
  const history = [];
  let histIdx = 0;

  function promptStr() { return `4004${cwd}> `; }

  function broadcast() {
    const payload = `data: ${JSON.stringify(fb.frame())}\n\n`;
    for (const res of clients) res.write(payload);
    frameDirty = false;
  }

  function redrawInput() {
    const prompt = promptStr();
    const clearLen = Math.min(prompt.length + Math.max(drawnLen, inputBuf.length), fb.cols - 1);
    fb.write('\r' + ' '.repeat(clearLen) + '\r' + prompt + inputBuf);
    drawnLen = inputBuf.length;
    frameDirty = true;
  }

  function submitLine() {
    const cmd = inputBuf;
    fb.write('\n');
    inputBuf = '';
    if (cmd.trim()) { history.push(cmd); histIdx = history.length; }
    drawnLen = 0;
    const keep = handle(cmd);
    if (!keep) fb.write('[session closed]\n');
    else fb.write(promptStr());
    frameDirty = true;
  }

  function onKey(key) {
    if (key === 'Enter') { submitLine(); return; }
    if (key === 'Backspace') {
      if (inputBuf.length) {
        inputBuf = inputBuf.slice(0, -1);
        drawnLen = inputBuf.length;
        fb.write('\b \b');
        frameDirty = true;
      }
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      if (!history.length) return;
      histIdx = Math.max(0, Math.min(history.length, histIdx + (key === 'ArrowUp' ? -1 : 1)));
      inputBuf = history[histIdx] || '';
      redrawInput();
      return;
    }
    if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) <= 126) {
      inputBuf += key;
      drawnLen = inputBuf.length;
      fb.write(key);
      frameDirty = true;
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
  out(BANNER);
  rl.setPrompt(`4004${cwd}> `);
  rl.prompt();
  rl.on('line', (line) => {
    if (handle(line) !== false) rl.prompt();
  });
  rl.on('close', () => out('\n'));
}
