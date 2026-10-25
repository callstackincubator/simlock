// `parseShell(command)`: the simple commands a Bash tool call runs, for the tool guard's rules
// that need a command's real words (a quoted `--body`, a `--head` value) rather than the
// blanked text the older rules match. Each command is `{ words, dynamic, stdin, redirects }`:
// `words` are the unquoted words, `dynamic[i]` says word i holds a `$(…)`, a backtick or a
// `$VAR` the guard cannot read, `stdin` is a heredoc or here-string body (null when none), and
// `redirects` are `{ op, target }` pairs. The words of a `$(…)` or backtick substitution become
// commands of their own. A `$(cat <<'EOF' … EOF)` inside a word is read as its heredoc body. It
// never throws: input it cannot follow ends the command it is in. `commandWords(cmd)` is a
// command's words from the program name on, without leading `VAR=value` assignments, wrappers
// (`env`, `time`, ...) or a `timeout <n>`.
export function parseShell(command) {
  const commands = [];
  parseInto(String(command ?? ""), commands);
  return commands;
}

const WRAPPERS = new Set(["time", "nice", "env", "command", "exec", "nohup"]);

export function commandWords(cmd) {
  let at = 0;
  const { words } = cmd;
  while (at < words.length && (/^\w+=/.test(words[at]) || WRAPPERS.has(words[at]))) at++;
  if (words[at] === "timeout") at += 2;
  return { words: words.slice(at), dynamic: cmd.dynamic.slice(at) };
}

function parseInto(src, commands) {
  let i = 0;
  let cmd = newCommand();
  let word = null;
  let redirectOp = null;
  const pending = [];

  const current = () => (word ??= { text: "", dynamic: false });
  const endWord = () => {
    if (word === null) return;
    if (redirectOp === "<<<") cmd.stdin = word.text;
    else if (redirectOp !== null) cmd.redirects.push({ op: redirectOp, target: word.text });
    else {
      cmd.words.push(word.text);
      cmd.dynamic.push(word.dynamic);
    }
    redirectOp = null;
    word = null;
  };
  const endCommand = () => {
    endWord();
    redirectOp = null;
    if (cmd.words.length > 0 || cmd.redirects.length > 0 || cmd.stdin !== null) commands.push(cmd);
    cmd = newCommand();
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      endCommand();
      i++;
      // why: heredoc bodies start on the line after the operator, in the order they were opened.
      for (const doc of pending.splice(0)) {
        const lines = [];
        while (i < src.length) {
          const eol = src.indexOf("\n", i);
          const line = src.slice(i, eol === -1 ? src.length : eol);
          i = eol === -1 ? src.length : eol + 1;
          if ((doc.strip ? line.replace(/^\t+/, "") : line).trim() === doc.delimiter) break;
          lines.push(doc.strip ? line.replace(/^\t+/, "") : line);
        }
        doc.cmd.stdin = lines.join("\n");
        doc.cmd.stdinDynamic = !doc.quoted && /[$`]/.test(doc.cmd.stdin);
      }
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        current().text += src[i + 1] ?? "";
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      current().text += src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      i = readDoubleQuoted(src, i + 1, current(), commands);
      continue;
    }
    if (c === "$") {
      i = readDollar(src, i, current(), commands);
      continue;
    }
    if (c === "`") {
      i = readBacktick(src, i, current(), commands);
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      endWord();
      redirectOp = "<<<";
      i += 3;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      endWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (src[i] === " " || src[i] === "\t") i++;
      const quote = src[i] === "'" || src[i] === '"' ? src[i] : "";
      if (quote !== "") i++;
      let delimiter = "";
      while (i < src.length && !/[\s;&|()<>'"]/.test(src[i])) delimiter += src[i++];
      if (quote !== "" && src[i] === quote) i++;
      pending.push({ cmd, delimiter, strip, quoted: quote !== "" });
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      if (word !== null && /^\d+$/.test(word.text) && !word.dynamic) word = null;
      else endWord();
      let op = c;
      i++;
      while (i < src.length && /[>&|]/.test(src[i]) && op.length < 3) op += src[i++];
      if (op.endsWith("&") && /[\d-]/.test(src[i] ?? "")) {
        while (/[\d-]/.test(src[i] ?? "")) i++;
        continue;
      }
      redirectOp = op;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      endCommand();
      i++;
      continue;
    }
    current().text += c;
    i++;
  }
  endCommand();
}

function newCommand() {
  return { words: [], dynamic: [], stdin: null, stdinDynamic: false, redirects: [] };
}

function readDoubleQuoted(src, i, word, commands) {
  while (i < src.length && src[i] !== '"') {
    const c = src[i];
    if (c === "\\" && /[$`"\\\n]/.test(src[i + 1] ?? "")) {
      if (src[i + 1] !== "\n") word.text += src[i + 1];
      i += 2;
    } else if (c === "$") {
      i = readDollar(src, i, word, commands);
    } else if (c === "`") {
      i = readBacktick(src, i, word, commands);
    } else {
      word.text += c;
      i++;
    }
  }
  return i + 1;
}

// why: `"$(cat <<'EOF' … EOF)"` is how a model writes a long body inline; its text is plain.
const CAT_HEREDOC = /^\$\(\s*cat\s*<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n\s*\)/;

function readDollar(src, i, word, commands) {
  const next = src[i + 1] ?? "";
  if (next === "(") {
    const doc = CAT_HEREDOC.exec(src.slice(i));
    if (doc !== null) {
      word.text += doc[3];
      if (doc[1] === "" && /[$`]/.test(doc[3])) word.dynamic = true;
      return i + doc[0].length;
    }
    const end = matchingParen(src, i + 2);
    parseInto(src.slice(i + 2, end), commands);
    word.dynamic = true;
    return end + 1;
  }
  if (next === "'") {
    let j = i + 2;
    while (j < src.length && src[j] !== "'") {
      if (src[j] === "\\" && j + 1 < src.length) {
        word.text += { n: "\n", t: "\t", "\\": "\\", "'": "'" }[src[j + 1]] ?? src[j + 1];
        j += 2;
      } else word.text += src[j++];
    }
    return j + 1;
  }
  if (next === "{") {
    const end = src.indexOf("}", i);
    word.dynamic = true;
    return end === -1 ? src.length : end + 1;
  }
  if (/[\w@*#?$!-]/.test(next)) {
    let j = i + 1;
    if (/\w/.test(next)) while (/\w/.test(src[j] ?? "")) j++;
    else j++;
    word.dynamic = true;
    return j;
  }
  word.text += "$";
  return i + 1;
}

function readBacktick(src, i, word, commands) {
  const end = src.indexOf("`", i + 1);
  parseInto(src.slice(i + 1, end === -1 ? src.length : end), commands);
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
