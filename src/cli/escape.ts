// why: C0 (NUL, ESC, CR, LF, tab...), DEL and C1 (\u009b is a CSI) are what a terminal acts on instead of showing.
const CONTROL = /\p{Cc}/gu;

export function escapeControl(text: string): string {
  return text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// why: log text is many lines; escaping the whole text would turn the line breaks into \u000a.
export function escapeControlLines(text: string): string {
  return text.split("\n").map(escapeControl).join("\n");
}
