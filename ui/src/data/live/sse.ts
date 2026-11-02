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
      const find = (char: string) => {
        const at = text.indexOf(char, start);
        return at < 0 ? Infinity : at;
      };
      let nextLf = find("\n");
      let nextCr = find("\r");
      for (;;) {
        const lf = nextLf < nextCr;
        const index = lf ? nextLf : nextCr;
        if (index === Infinity) break;
        pieces.push(text.slice(start, index));
        if (!lf && index === text.length - 1) {
          // why: a `\r` at the very end is not complete yet: the next chunk may start with the `\n` that makes it one `\r\n`.
          crPending = true;
          return out;
        }
        finish(out);
        start = index + (!lf && text[index + 1] === "\n" ? 2 : 1);
        if (nextLf < start) nextLf = find("\n");
        if (nextCr < start) nextCr = find("\r");
      }
      if (start < text.length) pieces.push(text.slice(start));
      return out;
    },
  };
}

function idField(id: string | undefined): { readonly id?: string } {
  return id === undefined ? {} : { id };
}
