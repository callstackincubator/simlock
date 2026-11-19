// `parseShell(command)`: the simple commands a Bash tool call runs, for the tool guard's rules
// that need a command's real words (a quoted `--body`, a `--head` value) rather than the
// blanked text the older rules match. Each command is `{ words, dynamic, stdin, redirects }`:
// `words` are the unquoted words, `dynamic[i]` says word i holds a `$(…)`, a backtick or a
// `$VAR` the guard cannot read, `stdin` is a heredoc or here-string body (null when none), and
// `redirects` are `{ op, target }` pairs. The words of a `$(…)` or backtick substitution become
// commands of their own. A `$(cat <<'EOF' … EOF)` inside a word is read as its heredoc body. It
// never throws: input it cannot follow ends the command it is in. A `$VAR` or `${VAR}` reads as
// its value when the call sets VAR once, to a literal, in a command of its own before the use
// (`F=/tmp/body.md; gh pr comment 5 --body-file "$F"`). `commandWords(cmd)` is a
// command's words from the program name on, without leading `VAR=value` assignments, wrappers
// (`env`, `time`, ...) or a `timeout <n>`.
export function parseShell(command) {
  const src = String(command ?? "");
  const scan = { commands: [], once: new Set(), vars: new Map() };
  parseInto(src, scan);
  const ctx = { commands: [], once: setOnce(scan.commands), vars: new Map() };
  parseInto(src, ctx);
  return ctx.commands;
}

const NAME_SETTERS = new Set([
  "for",
  "select",
  "read",
  "local",
  "declare",
  "typeset",
  "readonly",
  "getopts",
  "mapfile",
  "readarray",
  "unset",
]);

// why: a name the call sets twice, or through `read`, a loop or a declaration, has a value only
// the shell knows; one set once has the value its assignment shows.
function setOnce(commands) {
  const count = new Map();
  const bump = (name, by) => count.set(name, (count.get(name) ?? 0) + by);
  for (const { words } of commands) {
    const declares = words.some((w) => NAME_SETTERS.has(w));
    for (const word of words) {
      const name = /^(\w+)\+?=/.exec(word)?.[1];
      if (name !== undefined) bump(name, 1);
      else if (declares && /^\w+$/.test(word)) bump(word, 2);
    }
  }
  return new Set([...count].filter(([, n]) => n === 1).map(([name]) => name));
}

const WRAPPERS = new Set(["time", "nice", "env", "command", "exec", "nohup"]);

export function commandWords(cmd) {
  let at = 0;
  const { words } = cmd;
  while (at < words.length && (/^\w+=/.test(words[at]) || WRAPPERS.has(words[at]))) at++;
  if (words[at] === "timeout") at += 2;
  return { words: words.slice(at), dynamic: cmd.dynamic.slice(at) };
}

// why: one entry per character class the scanner meets; the first whose `at` holds scans it.
const SCANNERS = [
  { at: (p) => p.src[p.i] === "\n", scan: newline },
  { at: (p) => p.src[p.i] === " " || p.src[p.i] === "\t", scan: blank },
  { at: (p) => p.src[p.i] === "#" && p.word === null, scan: comment },
  { at: (p) => p.src[p.i] === "\\", scan: escaped },
  { at: (p) => p.src[p.i] === "'", scan: singleQuoted },
  {
    at: (p) => p.src[p.i] === '"',
    scan: (p) => (p.i = readDoubleQuoted(p.src, p.i + 1, current(p), p.ctx)),
  },
  {
    at: (p) => p.src[p.i] === "$",
    scan: (p) => (p.i = readDollar(p.src, p.i, current(p), p.ctx)),
  },
  {
    at: (p) => p.src[p.i] === "`",
    scan: (p) => (p.i = readBacktick(p.src, p.i, current(p), p.ctx)),
  },
  { at: (p) => p.src.startsWith("<<<", p.i), scan: hereString },
  { at: (p) => p.src.startsWith("<<", p.i), scan: heredoc },
  { at: (p) => /^(?:[<>]|&>)/.test(p.src.slice(p.i, p.i + 2)), scan: redirect },
  { at: (p) => ";|&()".includes(p.src[p.i]), scan: separator },
];

function parseInto(src, ctx) {
  const p = { src, ctx, i: 0, cmd: newCommand(), word: null, redirectOp: null, pending: [] };
  while (p.i < src.length) {
    const scanner = SCANNERS.find((s) => s.at(p));
    if (scanner === undefined) current(p).text += src[p.i++];
    else scanner.scan(p);
  }
  endCommand(p);
}

function current(p) {
  p.word ??= { text: "", dynamic: false };
  return p.word;
}

function endWord(p) {
  if (p.word === null) return;
  if (p.redirectOp === "<<<") p.cmd.stdin = p.word.text;
  else if (p.redirectOp !== null) p.cmd.redirects.push({ op: p.redirectOp, target: p.word.text });
  else {
    p.cmd.words.push(p.word.text);
    p.cmd.dynamic.push(p.word.dynamic);
  }
  p.redirectOp = null;
  p.word = null;
}

function endCommand(p) {
  endWord(p);
  p.redirectOp = null;
  const { cmd } = p;
  rememberAssignments(p.ctx, cmd);
  if (cmd.words.length > 0 || cmd.redirects.length > 0 || cmd.stdin !== null)
    p.ctx.commands.push(cmd);
  p.cmd = newCommand();
}

// why: `F=x` alone on a command sets a shell variable; before a program it sets only that
// program's environment, after the shell has expanded the command's own `$F`.
function rememberAssignments(ctx, cmd) {
  const from = cmd.words[0] === "export" ? 1 : 0;
  const assigned = cmd.words.slice(from).map((word) => /^(\w+)=([\s\S]*)$/.exec(word));
  if (assigned.includes(null)) return;
  assigned.forEach((found, i) => {
    if (ctx.once.has(found[1]) && !cmd.dynamic[from + i]) ctx.vars.set(found[1], found[2]);
  });
}

function newline(p) {
  endCommand(p);
  p.i++;
  // why: heredoc bodies start on the line after the operator, in the order they were opened.
  for (const doc of p.pending.splice(0)) readHeredocBody(p, doc);
}

function readHeredocBody(p, doc) {
  const lines = [];
  while (p.i < p.src.length) {
    const line = nextLine(p);
    const text = doc.strip ? line.replace(/^\t+/, "") : line;
    if (text.trim() === doc.delimiter) break;
    lines.push(text);
  }
  doc.cmd.stdin = lines.join("\n");
  doc.cmd.stdinDynamic = !doc.quoted && /[$`]/.test(doc.cmd.stdin);
}

function nextLine(p) {
  const eol = p.src.indexOf("\n", p.i);
  const end = eol === -1 ? p.src.length : eol;
  const line = p.src.slice(p.i, end);
  p.i = end + 1;
  return line;
}

function blank(p) {
  endWord(p);
  p.i++;
}

function comment(p) {
  while (p.i < p.src.length && p.src[p.i] !== "\n") p.i++;
}

function escaped(p) {
  if (p.src[p.i + 1] !== "\n") current(p).text += p.src[p.i + 1] ?? "";
  p.i += 2;
}

function singleQuoted(p) {
  const end = p.src.indexOf("'", p.i + 1);
  const close = end === -1 ? p.src.length : end;
  current(p).text += p.src.slice(p.i + 1, close);
  p.i = close + 1;
}

function hereString(p) {
  endWord(p);
  p.redirectOp = "<<<";
  p.i += 3;
}

function heredoc(p) {
  endWord(p);
  p.i += 2;
  const strip = p.src[p.i] === "-";
  if (strip) p.i++;
  while (p.src[p.i] === " " || p.src[p.i] === "\t") p.i++;
  p.pending.push({ cmd: p.cmd, strip, ...readDelimiter(p) });
}

function readDelimiter(p) {
  const { src } = p;
  const quote = src[p.i] === "'" || src[p.i] === '"' ? src[p.i] : "";
  if (quote !== "") p.i++;
  let delimiter = "";
  while (p.i < src.length && !/[\s;&|()<>'"]/.test(src[p.i])) delimiter += src[p.i++];
  if (quote !== "" && src[p.i] === quote) p.i++;
  return { delimiter, quoted: quote !== "" };
}

function redirect(p) {
  // why: a number right before the operator is the file descriptor, not a word.
  if (p.word !== null && /^\d+$/.test(p.word.text) && !p.word.dynamic) p.word = null;
  else endWord(p);
  const op = readOperator(p);
  if (op.endsWith("&") && /[\d-]/.test(p.src[p.i] ?? "")) {
    while (/[\d-]/.test(p.src[p.i] ?? "")) p.i++;
    return;
  }
  p.redirectOp = op;
}

function readOperator(p) {
  let op = p.src[p.i++];
  while (p.i < p.src.length && /[>&|]/.test(p.src[p.i]) && op.length < 3) op += p.src[p.i++];
  return op;
}

function separator(p) {
  endCommand(p);
  p.i++;
}

function newCommand() {
  return { words: [], dynamic: [], stdin: null, stdinDynamic: false, redirects: [] };
}

function readDoubleQuoted(src, i, word, ctx) {
  while (i < src.length && src[i] !== '"') {
    const c = src[i];
    if (c === "\\" && /[$`"\\\n]/.test(src[i + 1] ?? "")) {
      if (src[i + 1] !== "\n") word.text += src[i + 1];
      i += 2;
    } else if (c === "$") {
      i = readDollar(src, i, word, ctx);
    } else if (c === "`") {
      i = readBacktick(src, i, word, ctx);
    } else {
      word.text += c;
      i++;
    }
  }
  return i + 1;
}

// why: `"$(cat <<'EOF' … EOF)"` is how a model writes a long body inline; its text is plain.
const CAT_HEREDOC = /^\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n\s*\)/;

// why: what follows a `$` decides what it starts; the first entry whose `at` holds reads it.
const DOLLARS = [
  { at: (next) => next === "(", read: dollarParen },
  { at: (next) => next === "'", read: ansiQuoted },
  { at: (next) => next === "{", read: dollarBrace },
  { at: (next) => /[\w@*#?$!-]/.test(next), read: dollarName },
];

function readDollar(src, i, word, ctx) {
  const next = src[i + 1] ?? "";
  const reader = DOLLARS.find((d) => d.at(next));
  if (reader !== undefined) return reader.read(src, i, word, ctx);
  word.text += "$";
  return i + 1;
}

function dollarParen(src, i, word, ctx) {
  const doc = CAT_HEREDOC.exec(src.slice(i));
  if (doc !== null) {
    word.text += doc[3];
    if (doc[1] === "" && /[$`]/.test(doc[3])) word.dynamic = true;
    return i + doc[0].length;
  }
  const end = matchingParen(src, i + 2);
  parseInto(src.slice(i + 2, end), ctx);
  word.dynamic = true;
  return end + 1;
}

const ANSI_ESCAPES = { n: "\n", t: "\t", "\\": "\\", "'": "'" };

function ansiQuoted(src, i, word) {
  let j = i + 2;
  while (j < src.length && src[j] !== "'") {
    if (src[j] === "\\" && j + 1 < src.length) {
      word.text += ANSI_ESCAPES[src[j + 1]] ?? src[j + 1];
      j += 2;
    } else word.text += src[j++];
  }
  return j + 1;
}

function dollarBrace(src, i, word, ctx) {
  const end = src.indexOf("}", i);
  expand(word, ctx, end === -1 ? "" : src.slice(i + 2, end));
  return end === -1 ? src.length : end + 1;
}

function dollarName(src, i, word, ctx) {
  let j = i + 2;
  if (/\w/.test(src[i + 1])) while (/\w/.test(src[j] ?? "")) j++;
  expand(word, ctx, src.slice(i + 1, j));
  return j;
}

function expand(word, ctx, name) {
  if (ctx.vars.has(name)) word.text += ctx.vars.get(name);
  else word.dynamic = true;
}

function readBacktick(src, i, word, ctx) {
  const end = src.indexOf("`", i + 1);
  parseInto(src.slice(i + 1, end === -1 ? src.length : end), ctx);
  word.dynamic = true;
  return end === -1 ? src.length : end + 1;
}

function matchingParen(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return i;
    i++;
  }
  return src.length;
}
