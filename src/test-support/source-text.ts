// why: a repo-wide test that greps source for a pattern must not match a comment that cites it,
// and some must not match a string either; regex-only stripping (`imports.ts`'s `stripComments`)
// reads `"https://…"` as a comment and `"src/**/*.ts"` as a block comment. This walks strings,
// template literals and regex literals, and keeps every newline, so a line number still holds.
export function blankSource(text: string, { strings = false } = {}): string {
  const out = text.split("");
  const n = text.length;
  const braces: number[] = [];
  let last = "";
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const literal = (from: number, to: number) => {
    if (strings) blank(from, to);
  };
  const template = (start: number): number => {
    let j = start;
    while (j < n) {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "`") {
        literal(start, j);
        return j + 1;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        literal(start, j);
        braces.push(0);
        return j + 2;
      } else j++;
    }
    literal(start, n);
    return n;
  };
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "/" && (d === "/" || d === "*")) {
      const end = d === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 2;
      const stop = end <= 1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      literal(i + 1, Math.min(j, n));
      i = j + 1;
      last = c;
    } else if (c === "`" || (c === "}" && braces.at(-1) === 0)) {
      if (c === "}") braces.pop();
      i = template(i + 1);
      last = "`";
    } else if (c === "/" && regexCanStart(text, i, last)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      i = j + 1;
      last = "/";
    } else {
      if (braces.length > 0 && c === "{") braces[braces.length - 1]! += 1;
      if (braces.length > 0 && c === "}") braces[braces.length - 1]! -= 1;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out.join("");
}

function regexCanStart(text: string, i: number, last: string): boolean {
  if (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last)) return true;
  return /\b(?:return|typeof|case|of|in|yield|await|void|delete|throw)$/.test(
    text.slice(Math.max(0, i - 12), i).trimEnd(),
  );
}
