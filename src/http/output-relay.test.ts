import { describe, expect, it } from "vitest";

import { OutputRelay } from "./output-relay.js";

/**
 * ADR 0005 §19e: output is streamed, never buffered. The one window where a chunk waits is
 * between the process starting and the SSE stream opening -- of unknown length, since
 * `attach` runs inside hono's own callback -- and backpressure applies there exactly as it
 * does once streaming, which is what keeps that window's memory bounded regardless of its
 * duration. The other thing that must never grow is what a disconnected client's command
 * keeps writing.
 */
describe("OutputRelay", () => {
  it("holds what arrives before the stream opens, then flushes it in order", () => {
    const relay = new OutputRelay();
    const written: string[] = [];

    relay.push({ chunk: "one", stream: "stdout" });
    relay.push({ chunk: "two", stream: "stderr" });
    expect(relay.bufferedCount).toBe(2);

    relay.attach(async (chunk) => {
      written.push(`${chunk.stream}:${chunk.chunk}`);
    });
    expect(written).toEqual(["stdout:one", "stderr:two"]);
    expect(relay.bufferedCount).toBe(0);

    relay.push({ chunk: "three", stream: "stdout" });
    expect(written).toEqual(["stdout:one", "stderr:two", "stdout:three"]);
    expect(relay.bufferedCount).toBe(0);
  });

  it("keeps nothing at all once the client is gone, however much the command writes", () => {
    // The command deliberately keeps running after a disconnect, for up to `exec.timeoutMs`.
    // If its output were retained meanwhile, one request per agent token would be a
    // memory-exhaustion lever with no cap on it -- which is the same defect as buffering.
    const relay = new OutputRelay();
    const written: string[] = [];
    relay.attach(async (chunk) => {
      written.push(chunk.chunk);
    });

    relay.drop();
    for (let index = 0; index < 1_000; index += 1) {
      relay.push({ chunk: "x".repeat(1_024), stream: "stdout" });
    }

    expect(relay.bufferedCount).toBe(0);
    expect(written).toEqual([]);
  });

  it("hands a delivery's promise back, so a slow client can stop the command", async () => {
    // ADR 0005 §19e end to end: the process runner awaits what `onOutput` returns, and what
    // `onOutput` returns is this. A client that opened the stream and stopped reading
    // therefore stalls the command rather than filling this process with its output.
    const relay = new OutputRelay();
    let releaseWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    relay.attach(() => write);

    let delivered = false;
    void Promise.resolve(relay.push({ chunk: "one", stream: "stdout" })).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(relay.bufferedCount).toBe(0);

    releaseWrite();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toBe(true);
  });

  it("backpressures a chunk pushed before the stream opens, not just after", async () => {
    // `attach` runs inside hono's `streamSSE` callback, which is not guaranteed to be the very
    // next turn of the event loop -- so a fast producer (`adb shell cat /dev/urandom`) that
    // writes during the starting window must stall on the first chunk exactly as it would once
    // streaming, or this window is an unbounded buffer with a different name.
    const relay = new OutputRelay();
    let delivered = false;

    void Promise.resolve(relay.push({ chunk: "one", stream: "stdout" })).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // Still held, not yet delivered -- but held as exactly one chunk's promise, not an
    // ever-growing array: a second push before `attach` still resolves only once flushed.
    expect(delivered).toBe(false);
    expect(relay.bufferedCount).toBe(1);

    const written: string[] = [];
    relay.attach(async (chunk) => {
      written.push(chunk.chunk);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(written).toEqual(["one"]);
    expect(delivered).toBe(true);
  });

  it("resolves a starting-window chunk's promise immediately if the client leaves before the stream ever opens", async () => {
    // `drop()` must not leave a paused process runner waiting forever on a delivery that
    // `attach` will now never make -- the chunk has nowhere to go, exactly like one arriving
    // after the drop, so its caller is released rather than stalled.
    const relay = new OutputRelay();
    let delivered = false;

    void Promise.resolve(relay.push({ chunk: "before", stream: "stdout" })).then(() => {
      delivered = true;
    });
    await Promise.resolve();
    expect(delivered).toBe(false);

    relay.drop();
    await Promise.resolve();
    await Promise.resolve();

    expect(delivered).toBe(true);
    expect(relay.bufferedCount).toBe(0);
  });

  it("keeps nothing when the client leaves before the stream ever opened either", () => {
    const relay = new OutputRelay();
    relay.push({ chunk: "before", stream: "stdout" });

    relay.drop();
    for (let index = 0; index < 1_000; index += 1) {
      relay.push({ chunk: "x".repeat(1_024), stream: "stdout" });
    }
    expect(relay.bufferedCount).toBe(0);

    // And a late `attach` -- an SSE callback that runs after the abort -- delivers nothing
    // rather than resurrecting the stream.
    const written: string[] = [];
    relay.attach(async (chunk) => {
      written.push(chunk.chunk);
    });
    relay.push({ chunk: "after", stream: "stdout" });
    expect(written).toEqual([]);
  });
});
