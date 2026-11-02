// why: the browser's `EventSource` cannot send the `Authorization` header, so the console parses
// the frames itself.

export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

export interface SseParser {
  push(chunk: Uint8Array | string): SseMessage[];
}

// why: a chunk may end anywhere (inside a line, between a `\r` and its `\n`, or inside a UTF-8
// character), so what cannot be finished yet waits for the next chunk.
export function createSseParser(): SseParser {
  const decoder = new TextDecoder();
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const dispatch = (out: SseMessage[]) => {
    if (data.length > 0) {
      out.push({ data: data.join("\n"), event: event === "" ? "message" : event, ...idField(id) });
    }
    event = "";
    data = [];
  };

  const field = (text: string) => {
    const colon = text.indexOf(":");
    const name = colon < 0 ? text : text.slice(0, colon);
    const raw = colon < 0 ? "" : text.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (name === "event") event = value;
    else if (name === "data") data.push(value);
    else if (name === "id" && !value.includes("\0")) id = value;
  };

  const line = (text: string, out: SseMessage[]) => {
    if (text === "") dispatch(out);
    else if (!text.startsWith(":")) field(text);
  };

  // why: the text of the line still being read, kept in pieces so a line split across many chunks is scanned once, when its chunk arrives, and joined once, when it ends.
  let pieces: string[] = [];
  let crPending = false;

  const finish = (out: SseMessage[]) => {
    const text = pieces.join("");
    pieces = [];
    line(text, out);
  };

  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const out: SseMessage[] = [];
      let start = 0;
      if (crPending) {
        crPending = false;
        finish(out);
        if (text.startsWith("\n")) start = 1;
      }
      const next = createBreakFinder(text);
      for (let found = next(start); found !== undefined; found = next(start)) {
        pieces.push(text.slice(start, found.index));
        if (found.endsText) {
          crPending = true;
          return out;
        }
        finish(out);
        start = found.index + found.length;
      }
      if (start < text.length) pieces.push(text.slice(start));
      return out;
    },
  };
}

function idField(id: string | undefined): { readonly id?: string } {
  return id === undefined ? {} : { id };
}

interface LineBreak {
  readonly index: number;
  readonly length: number;
  // why: a `\r` at the very end is not complete yet: the next chunk may start with the `\n` that makes it one `\r\n`.
  readonly endsText: boolean;
}

// why: each of `\n` and `\r` is searched for again only once the search has moved past its last hit, so the text is scanned once however many breaks it holds.
function createBreakFinder(text: string): (from: number) => LineBreak | undefined {
  const find = (char: string, from: number) => {
    const at = text.indexOf(char, from);
    return at < 0 ? Infinity : at;
  };
  let nextLf = -1;
  let nextCr = -1;
  return (from) => {
    if (nextLf < from) nextLf = find("\n", from);
    if (nextCr < from) nextCr = find("\r", from);
    if (nextLf === Infinity && nextCr === Infinity) return undefined;
    if (nextLf < nextCr) return { endsText: false, index: nextLf, length: 1 };
    return {
      endsText: nextCr === text.length - 1,
      index: nextCr,
      length: text[nextCr + 1] === "\n" ? 2 : 1,
    };
  };
}
