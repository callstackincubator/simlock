import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../data/api";
import { capture, type CaptureSinks, refusalOf, STREAM_HEAD_TIMEOUT_MS } from "./screen";

describe("what a refused stream says", () => {
  it("says only that this device cannot be streamed, naming no platform, when the daemon answers 415", () => {
    const refused = new ApiError(
      415,
      undefined,
      "A physical iPhone's screen cannot be streamed; only a simulator's can",
    );

    expect(refusalOf(refused)).toBe("This device cannot be streamed.");
  });

  it("waits for a stream's headers past the longest open a physical Android phone's capture can take", () => {
    // why: a phone's open may spend about 185 s: the shared adb server's version check up to 45 s
    // the first time and 5 s before each later step, the screen read, the wake and the second read
    // 20 s each, the push 40 s, the server 15 s and a last check past it.
    // A console that gave up sooner would show its own timeout instead of the worker's reason.
    expect(STREAM_HEAD_TIMEOUT_MS).toBe(200_000);
  });

  it("keeps the daemon's own reason when it named one, and says what else to check", () => {
    const refused = new ApiError(404, undefined, "Unknown device: dev_1");

    expect(refusalOf(refused)).toBe(
      "Unknown device: dev_1 A stream is only offered where capabilities.stream.enabled is on.",
    );
  });

  it("keeps a capture program's own words when the worker could not run one", () => {
    const refused = new ApiError(
      500,
      undefined,
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );

    expect(refusalOf(refused)).toBe(
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );
  });

  it("keeps the daemon's words for a refusal this console has no advice about", () => {
    expect(refusalOf(new ApiError(401, "UNAUTHENTICATED", "Unknown bearer token"))).toBe(
      "Unknown bearer token",
    );
  });

  it("says what the browser itself threw, rather than that something went wrong", () => {
    expect(refusalOf(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
    expect(refusalOf("nope")).toBe("nope");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// why: `capture` is the retry loop and the console has no DOM test of the screen panel (a hook over
// WebCodecs and a canvas); the loop's order of opens, waits and ends is what the surface cannot force.
describe("a screen stream the server ends", () => {
  it("is opened again when a started stream ends with no reason, as when a signed-in identity expired, and stays ended when the lease ended, the viewer left or no picture had started", async () => {
    vi.useFakeTimers();
    const frame = (tag: number, payload: object) => {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const out = new Uint8Array(bytes.length + 5);
      new DataView(out.buffer).setUint32(0, bytes.length + 1);
      out[4] = tag;
      out.set(bytes, 5);
      return out;
    };
    const body = (chunks: Uint8Array[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    const ended: string[] = [];
    const sinks = {
      canvas: { current: null },
      conflict: () => undefined,
      ended: (reason: string) => ended.push(reason),
      live: () => undefined,
      setMeta: () => undefined,
      setStats: () => undefined,
    } satisfies CaptureSinks;
    const started = frame(0x05, { codec: "h264", fps: 30, height: 2, width: 1 });
    const answers = [[started], [started], [started, frame(0x07, { reason: "explicit" })]];
    let opened = 0;
    const api = {
      stream: async () => ({ body: body(answers[opened++] ?? []), date: null }),
    } as unknown as Parameters<typeof capture>[0];

    const watching = capture(api, "w1", "dev_1", new AbortController().signal, sinks);
    await vi.advanceTimersByTimeAsync(10_000);
    await watching;

    expect(opened).toBe(3);
    expect(ended).toEqual(["The lease was released."]);

    const left = new AbortController();
    left.abort();
    await capture(api, "w1", "dev_1", left.signal, sinks);
    expect(opened).toBe(4);
    expect(ended).toEqual(["The lease was released."]);

    answers.push([]);
    await capture(api, "w1", "dev_1", new AbortController().signal, sinks);
    expect(opened).toBe(5);
    expect(ended).toEqual(["The lease was released.", "The stream ended."]);
  });
});
