// 极简 shell：管道、重定向、逻辑运算、控制流
// 命令由外部注入 dispatch(ctx, argv) -> { code, output }，本模块只负责语法与流程

function tokenize(line) {
  const tokens = [];
  let i = 0;
  const isOp = c => '|;&<>'.includes(c);
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const c = line[i];
    // 注释：词首的 # 忽略到行尾（引号内的 # 在 word 循环里处理，不在此处）
    if (c === '#') break;
    if (c === '{' || c === '}') { tokens.push(c); i++; continue; }
    if (isOp(c)) {
      if (c === '|' && line[i + 1] === '|') { tokens.push('||'); i += 2; continue; }
      if (c === '&' && line[i + 1] === '&') { tokens.push('&&'); i += 2; continue; }
      if (c === '>') {
        if (line[i + 1] === '>') { tokens.push('>>'); i += 2; continue; }
        tokens.push('>'); i++; continue;
      }
      if (c === '<') { tokens.push('<'); i++; continue; }
      tokens.push(c); i++; continue;
    }
    let word = '';
    let quote = null;
    while (i < line.length) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) { quote = null; i++; continue; }
        if (ch === '\\' && quote === '"' && i + 1 < line.length) { word += line[i + 1]; i += 2; continue; }
        word += ch; i++; continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
      if (ch === '\\' && i + 1 < line.length) { word += line[i + 1]; i += 2; continue; }
      if (/\s/.test(ch) || isOp(ch) || ch === '{' || ch === '}') break;
      word += ch; i++;
    }
    tokens.push({ word });
  }
  return tokens;
}

// 按 ; && || 切分命令序列（返回带分隔符的段）
function splitList(tokens) {
  const parts = [];
  let cur = [];
  for (const t of tokens) {
    if (t === ';' || t === '&&' || t === '||') {
      parts.push({ tokens: cur, sep: null });
      parts.push({ sep: t });
      cur = [];
    } else cur.push(t);
  }
  parts.push({ tokens: cur, sep: null });
  return parts;
}

// 按 | 切分管道（只切最外层的，由调用方在不含控制符的段上用）
function splitPipeline(tokens) {
  const parts = [];
  let cur = [];
  for (const t of tokens) {
    if (t === '|') { parts.push(cur); cur = []; }
    else cur.push(t);
  }
  parts.push(cur);
  return parts;
}

class Shell {
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.vars = {};
    this.lastCode = 0;
    this.depth = 0;
  }

  expand(word, ctx) {
    if (typeof word !== 'string') return word;
    let s = word;
    // 算术展开 $((expr))
    s = s.replace(/\$\(\(([^)]*)\)\)/g, (m, expr) => {
      // 支持裸变量名与 $var 两种写法
      const e = expr.replace(/\$?([A-Za-z_][A-Za-z0-9_]*)/g, (mm, n) => this.vars[n] !== undefined ? this.vars[n] : '0');
      try {
        if (!/^[\d\s+\-*/%()]+$/.test(e)) return '0';
        return String(Function(`"use strict";return (${e})`)());
      } catch (err) { return '0'; }
    });
    s = s.replace(/\$(\?|[A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
      if (name === '?') return String(this.lastCode);
      return this.vars[name] !== undefined ? this.vars[name] : '';
    });
    return s;
  }

  // 展开 token 列表里的 word，保留操作符字符串
  expandTokens(tokens, ctx) {
    return tokens.map(t => typeof t === 'string' ? t : { word: this.expand(t.word, ctx) });
  }

  // 解析一条简单命令：argv + 重定向
  parseSimple(tokens) {
    const argv = [];
    let stdinFile = null, stdoutFile = null, append = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const w = typeof t === 'string' ? t : t.word;
      if (w === '>' || w === '>>' || w === '<') {
        if (i + 1 >= tokens.length) return { error: 'syntax error near unexpected token' };
        const target = tokens[++i];
        const file = typeof target === 'string' ? target : target.word;
        if (w === '<') stdinFile = file;
        else { stdoutFile = file; append = (w === '>>'); }
      } else argv.push(w);
    }
    return { argv, stdinFile, stdoutFile, append };
  }

  // 运行一条管道（tokens 内不含 ; && ||）
  runPipeline(tokens, ctx) {
    const stages = splitPipeline(tokens).filter(s => s.length);
    if (!stages.length) return { code: 0, output: '' };

    const results = [];
    let pipeIn = ctx.stdin !== undefined ? ctx.stdin : '';
    for (let si = 0; si < stages.length; si++) {
      const parsed = this.parseSimple(this.expandTokens(stages[si], ctx));
      if (parsed.error) return { code: 2, output: parsed.error + '\n' };
      const argv = parsed.argv;
      if (!argv.length) continue;

      // 变量赋值 VAR=value
      const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[0]);
      if (assign && argv.length === 1) {
        this.vars[assign[1]] = assign[2];
        results.push({ code: 0, output: '' });
        continue;
      }

      let input = si === 0 ? pipeIn : pipeIn;
      if (parsed.stdinFile !== null) {
        const r = this.dispatch(ctx, ['cat', parsed.stdinFile]);
        input = r.output || '';
      }

      const r = this.dispatch({ ...ctx, stdin: input }, argv) || { code: 0, output: '' };
      let output = r.output || '';
      if (parsed.stdoutFile !== null) {
        const wargv = ['write', parsed.stdoutFile, output];
        if (parsed.append) wargv.push('append');
        this.dispatch(ctx, wargv);
        output = '';
      }
      results.push({ code: r.code === undefined ? 0 : r.code, output });
      pipeIn = output;
    }
    const last = results[results.length - 1] || { code: 0, output: '' };
    return { code: last.code, output: last.output };
  }

  // 把 token 列表还原成源码字符串（用于递归 run）
  source(tokens) {
    return tokens.map(t => {
      if (typeof t === 'string') return ` ${t} `;
      return ` ${t.word} `;
    }).join('').replace(/\s+/g, ' ').trim();
  }

  // 在 tokens 中找配对的关键字位置（跳过引号内已展开的词）
  findKeyword(tokens, names, from = 0) {
    for (let i = from; i < tokens.length; i++) {
      const t = tokens[i];
      if (typeof t === 'string') continue;
      if (names.includes(t.word)) return i;
    }
    return -1;
  }

  // 执行控制流（for / if / while），返回 null 表示不是控制流
  runControl(tokens, ctx) {
    const first = tokens[0];
    if (!first || typeof first !== 'object') return null;
    const kw = first.word;
    if (!['for', 'if', 'while'].includes(kw)) return null;

    if (kw === 'for') {
      // for VAR in a b c; do BODY; done
      const inIdx = this.findKeyword(tokens, ['in'], 1);
      const doIdx = this.findKeyword(tokens, ['do'], 1);
      const doneIdx = this.findKeyword(tokens, ['done'], 1);
      if (inIdx < 0 || doIdx < 0 || doneIdx < 0) return { code: 2, output: 'for: syntax error\n' };
      const name = tokens[1] && typeof tokens[1] === 'object' ? tokens[1].word : '';
      const values = tokens.slice(inIdx + 1, doIdx)
        .filter(t => typeof t === 'object' && t.word !== ';')
        .map(t => t.word);
      const bodyTokens = tokens.slice(doIdx + 1, doneIdx);
      const body = this.source(bodyTokens);
      let output = '';
      let code = 0;
      for (const v of values) {
        this.vars[name] = v;
        const r = this.run(body, ctx);
        output += r.output || '';
        code = r.code;
        if (code !== 0) break;
      }
      return { code, output };
    }

    if (kw === 'while') {
      // while COND; do BODY; done
      const doIdx = this.findKeyword(tokens, ['do'], 1);
      const doneIdx = this.findKeyword(tokens, ['done'], 1);
      if (doIdx < 0 || doneIdx < 0) return { code: 2, output: 'while: syntax error\n' };
      const cond = this.source(tokens.slice(1, doIdx).filter(t => !(typeof t === 'string' && t === ';')));
      const body = this.source(tokens.slice(doIdx + 1, doneIdx));
      let output = '';
      let code = 0;
      let guard = 0;
      while (guard++ < 100) {
        const cr = this.run(cond, ctx);
        if (cr.code !== 0) break;
        const r = this.run(body, ctx);
        output += r.output || '';
        code = r.code;
        if (code !== 0) break;
      }
      return { code, output };
    }

    if (kw === 'if') {
      // if COND; then BODY; else BODY; fi
      const thenIdx = this.findKeyword(tokens, ['then'], 1);
      const elseIdx = this.findKeyword(tokens, ['else'], 1);
      const fiIdx = this.findKeyword(tokens, ['fi'], 1);
      if (thenIdx < 0 || fiIdx < 0) return { code: 2, output: 'if: syntax error\n' };
      const cond = this.source(tokens.slice(1, thenIdx).filter(t => !(typeof t === 'string' && t === ';')));
      const cr = this.run(cond, ctx);
      const hasElse = elseIdx > thenIdx && elseIdx < fiIdx;
      const bodyTokens = (hasElse ? tokens.slice(thenIdx + 1, elseIdx) : tokens.slice(thenIdx + 1, fiIdx));
      const elseTokens = hasElse ? tokens.slice(elseIdx + 1, fiIdx) : [];
      const chosen = cr.code === 0 ? bodyTokens : elseTokens;
      return this.run(this.source(chosen), ctx);
    }
    return null;
  }

  // 运行一串由 ; && || 分隔的段
  run(line, ctx = {}) {
    const tokens = tokenize(line);
    if (!tokens.length) return { code: 0, output: '' };

    // 先探测：若 token 流里有控制流，找其起止范围，整体交给 runControl
    const ctrlEnd = { for: 'done', while: 'done', if: 'fi' };
    let ctrlStart = -1, ctrlKind = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (typeof t === 'object' && ctrlEnd[t.word]) { ctrlStart = i; ctrlKind = t.word; break; }
    }
    if (ctrlStart >= 0) {
      // 控制流之前的前缀命令先执行（如 N=0;）
      const prefix = tokens.slice(0, ctrlStart).filter(t => typeof t === 'string' && [';', '&&', '||'].includes(t) ? false : true);
      let allOutput = '';
      if (prefix.length) {
        const pr = this.runPipeline(prefix, ctx);
        allOutput += pr.output || '';
      }
      const end = ctrlEnd[ctrlKind];
      let depth = 0, endIdx = ctrlStart;
      for (let j = ctrlStart; j < tokens.length; j++) {
        const x = tokens[j];
        if (typeof x !== 'object') continue;
        if (ctrlEnd[x.word]) depth++;
        if (x.word === end) { depth--; if (depth === 0) { endIdx = j; break; } }
      }
      const ctrlTokens = tokens.slice(ctrlStart, endIdx + 1);
      const cr = this.runControl(ctrlTokens, ctx) || { code: 2, output: 'control: syntax error\n' };
      allOutput += cr.output || '';
      // 控制流之后的尾段
      const tail = tokens.slice(endIdx + 1).filter(t => !(typeof t === 'string' && t === ';'));
      if (tail.length) {
        const tr = this.run(this.source(tail), ctx);
        allOutput += tr.output || '';
      }
      this.lastCode = cr.code;
      return { code: cr.code, output: allOutput };
    }

    const parts = splitList(tokens);
    let result = { code: 0, output: '' };
    let allOutput = '';
    let skip = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.sep) continue;
      if (skip) { skip = false; continue; }
      if (!part.tokens.length) continue;
      result = this.runPipeline(part.tokens, ctx);
      allOutput += result.output || '';
      this.lastCode = result.code;
      const next = parts[i + 1];
      if (next && next.sep) {
        if (next.sep === '&&' && result.code !== 0) skip = true;
        if (next.sep === '||' && result.code === 0) skip = true;
      }
    }
    return { code: result.code, output: allOutput };
  }
}

module.exports = { Shell, tokenize };
