import { describe, expect, it, vi } from "vitest";

import { createSseParser, type SseMessage } from "./sse";

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

    for (let cut = 1; cut < bytes.length; cut += 1) {
      const parser = createSseParser();
      const messages = [...parser.push(bytes.slice(0, cut)), ...parser.push(bytes.slice(cut))];
      expect(messages, `cut at byte ${cut}`).toEqual(EXPECTED);
    }

    const parser = createSseParser();
    const messages = [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)));
    expect(messages).toEqual(EXPECTED);
  });

  it("a message is not yielded before the blank line that ends it", () => {
    const parser = createSseParser();

    expect(parser.push("event: lease.granted\ndata: {}\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ data: "{}", event: "lease.granted" }]);
  });

  it("finds a line split across many chunks without rescanning it", () => {
    const data = "x".repeat(100_000);
    const body = `event: lease.requested\ndata: {"device":"${data}"}\n\n`;
    const original = String.prototype.indexOf;
    let scanned = 0;
    const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      ...args: Parameters<typeof original>
    ) {
      const found = original.apply(this, args);
      scanned += (found < 0 ? this.length : found) - (args[1] ?? 0);
      return found;
    });
    const parser = createSseParser();
    const messages: SseMessage[] = [];
    try {
      for (let at = 0; at < body.length; at += 16) {
        messages.push(...parser.push(body.slice(at, at + 16)));
      }
    } finally {
      spy.mockRestore();
    }

    expect(messages).toEqual([{ data: `{"device":"${data}"}`, event: "lease.requested" }]);
    expect(scanned).toBeLessThanOrEqual(3 * body.length);
  });
});
