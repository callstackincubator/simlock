import { describe, expect, it } from "vitest";

import { createSseParser, type SseMessage } from "./sse";

/** Three events as the daemon frames them, a keepalive between them, one in `\r\n` line ends
 * with two data lines, and a character that takes more than one byte. */
const BODY =
  'event: lease.granted\ndata: {"seq":1}\n\n' +
  ": keepalive\n\n" +
  "event: device.ready\r\ndata: first\r\ndata: second\r\nid: 7\r\n\r\n" +
  'event: worker.connected\ndata: {"label":"Łódź"}\n\n';

const EXPECTED: SseMessage[] = [
  { data: '{"seq":1}', event: "lease.granted" },
  { data: "first\nsecond", event: "device.ready", id: "7" },
  { data: '{"label":"Łódź"}', event: "worker.connected", id: "7" },
];

describe("createSseParser", () => {
  it("the SSE parser yields each event once across chunk boundaries", () => {
    const bytes = new TextEncoder().encode(BODY);

    const whole = createSseParser().push(bytes);
    expect(whole).toEqual(EXPECTED);

    // Every place one chunk can end and the next begin, including inside `\r\n` and inside
    // the two-byte characters.
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const parser = createSseParser();
      const messages = [...parser.push(bytes.slice(0, cut)), ...parser.push(bytes.slice(cut))];
      expect(messages, `cut at byte ${cut}`).toEqual(EXPECTED);
    }

    // One byte at a time.
    const parser = createSseParser();
    const messages = [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)));
    expect(messages).toEqual(EXPECTED);
  });

  it("a message is not yielded before the blank line that ends it", () => {
    const parser = createSseParser();

    expect(parser.push("event: lease.granted\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ data: "{}", event: "lease.granted" }]);
  });
});
