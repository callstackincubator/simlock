// why: a repo-wide test that greps source for a pattern must not match a comment that cites it,
// and some must not match a string either; regex-only stripping (`imports.ts`'s `stripComments`)
// reads `"https://…"` as a comment and `"src/**/*.ts"` as a block comment. This walks strings,
// template literals and regex literals, and keeps every newline, so a line number still holds.
// Each scanner reads one kind of token at `s.i` and moves past it; what none claims is code.
export function blankSource(text: string, { strings = false } = {}): string {
  const s: Scan = { text, out: text.split(""), i: 0, braces: [], last: "", strings };
  while (s.i < text.length) (SCANNERS.find((scanner) => scanner.at(s)) ?? CODE).scan(s);
  return s.out.join("");
}

interface Scan {
  readonly text: string;
  readonly out: string[];
  readonly braces: number[];
  readonly strings: boolean;
  i: number;
  last: string;
}

interface Scanner {
  readonly at: (s: Scan) => boolean;
  readonly scan: (s: Scan) => void;
}

const SCANNERS: readonly Scanner[] = [
  { at: (s) => s.text.startsWith("//", s.i), scan: (s) => skipComment(s, "\n", 0) },
  { at: (s) => s.text.startsWith("/*", s.i), scan: (s) => skipComment(s, "*/", 2) },
  { at: (s) => s.text[s.i] === '"' || s.text[s.i] === "'", scan: scanQuoted },
  { at: (s) => s.text[s.i] === "`", scan: (s) => scanTemplate(s, s.i + 1) },
  { at: (s) => s.text[s.i] === "}" && s.braces.at(-1) === 0, scan: resumeTemplate },
  { at: (s) => s.text[s.i] === "/" && regexCanStart(s), scan: scanRegex },
];
const CODE: Pick<Scanner, "scan"> = { scan: scanCode };

function blank(s: Scan, from: number, to: number): void {
  for (let k = from; k < to; k++) if (s.out[k] !== "\n") s.out[k] = " ";
}

function literal(s: Scan, from: number, to: number): void {
  if (s.strings) blank(s, from, to);
}

function skipComment(s: Scan, terminator: string, length: number): void {
  const found = s.text.indexOf(terminator, s.i + 2);
  const stop = found === -1 ? s.text.length : found + length;
  blank(s, s.i, stop);
  s.i = stop;
}

function scanQuoted(s: Scan): void {
  const quote = s.text[s.i]!;
  let j = s.i + 1;
  while (j < s.text.length && s.text[j] !== quote && s.text[j] !== "\n") {
    j += s.text[j] === "\\" ? 2 : 1;
  }
  literal(s, s.i + 1, Math.min(j, s.text.length));
  s.i = j + 1;
  s.last = quote;
}

function resumeTemplate(s: Scan): void {
  s.braces.pop();
  scanTemplate(s, s.i + 1);
}

function scanTemplate(s: Scan, start: number): void {
  let j = start;
  while (j < s.text.length && s.text[j] !== "`" && !s.text.startsWith("${", j)) {
    j += s.text[j] === "\\" ? 2 : 1;
  }
  literal(s, start, Math.min(j, s.text.length));
  if (s.text.startsWith("${", j)) s.braces.push(0);
  s.i = Math.min(j + (s.text[j] === "`" ? 1 : 2), s.text.length);
  s.last = "`";
}

function scanRegex(s: Scan): void {
  let j = s.i + 1;
  let inClass = false;
  while (j < s.text.length && s.text[j] !== "\n") {
    const c = s.text[j];
    if (c === "/" && !inClass) break;
    if (c === "[" || c === "]") inClass = c === "[";
    j += c === "\\" ? 2 : 1;
  }
  s.i = j + 1;
  s.last = "/";
}

function scanCode(s: Scan): void {
  const c = s.text[s.i]!;
  const top = s.braces.length - 1;
  if (top >= 0 && (c === "{" || c === "}")) s.braces[top]! += c === "{" ? 1 : -1;
  if (!/\s/.test(c)) s.last = c;
  s.i++;
}

function regexCanStart(s: Scan): boolean {
  if (s.last === "" || "(,=:[!&|?{};+-*%<>~^".includes(s.last)) return true;
  return /\b(?:return|typeof|case|of|in|yield|await|void|delete|throw)$/.test(
    s.text.slice(Math.max(0, s.i - 12), s.i).trimEnd(),
  );
}
