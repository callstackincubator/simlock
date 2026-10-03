/**
 * Server-Sent Events, read off a `fetch` body (ADR 0013 §2). The browser's `EventSource` would
 * parse this for us, but it cannot send the `Authorization` header, so the console parses the
 * frames itself. The format is the one the HTML standard defines: lines of `field: value`, a
 * blank line ends a message, a line starting with `:` is a comment (the daemon's keepalive).
 */

export interface SseMessage {
  /** The `event:` field, or `message` when the frame had none. */
  readonly event: string;
  /** Every `data:` line of the frame, joined with newlines. */
  readonly data: string;
  readonly id?: string;
}

export interface SseParser {
  /** Feeds the next chunk of the body and returns the messages it completed, in order. */
  push(chunk: Uint8Array | string): SseMessage[];
}

/**
 * A parser for one stream. A chunk may end anywhere: inside a line, between a `\r` and its
 * `\n`, or inside a UTF-8 character. What it cannot finish yet waits for the next chunk, so each
 * message comes out once, whole.
 */
export function createSseParser(): SseParser {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  /** A blank line: the message so far is complete, if it had any data. */
  const dispatch = (out: SseMessage[]) => {
    if (data.length > 0) {
      out.push({ data: data.join("\n"), event: event === "" ? "message" : event, ...idField(id) });
    }
    event = "";
    data = [];
  };

  /** `name: value`, or a bare `name`. Fields the console does not use are ignored. */
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

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const out: SseMessage[] = [];
      for (;;) {
        const end = lineEnd(buffer);
        if (end === undefined) break;
        line(buffer.slice(0, end.index), out);
        buffer = buffer.slice(end.index + end.length);
      }
      return out;
    },
  };
}

function idField(id: string | undefined): { readonly id?: string } {
  return id === undefined ? {} : { id };
}

/**
 * Where the first complete line in `text` ends. A `\r` at the very end is not complete yet: the
 * next chunk may start with the `\n` that makes it one `\r\n`.
 */
function lineEnd(text: string): { readonly index: number; readonly length: number } | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return { index, length: 1 };
    if (char === "\r") {
      if (index === text.length - 1) return undefined;
      return { index, length: text[index + 1] === "\n" ? 2 : 1 };
    }
  }
  return undefined;
}
