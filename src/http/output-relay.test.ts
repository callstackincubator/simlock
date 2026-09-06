import { describe, expect, it } from "vitest";

import { OutputRelay } from "./output-relay.js";

/**
 * ADR 0005 §19e: output is streamed, never buffered. The one window where a chunk waits is
 * between the process starting and the SSE stream opening -- one turn of the event loop -- and
 * the one thing that must never grow is what a disconnected client's command keeps writing.
 */
describe("OutputRelay", () => {
  it("holds what arrives before the stream opens, then flushes it in order", () => {
    const relay = new OutputRelay();
    const written: string[] = [];

    relay.push({ chunk: "one", stream: "stdout" });
    relay.push({ chunk: "two", stream: "stderr" });
    expect(relay.bufferedCount).toBe(2);

    relay.attach((chunk) => written.push(`${chunk.stream}:${chunk.chunk}`));
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
    relay.attach((chunk) => written.push(chunk.chunk));

    relay.drop();
    for (let index = 0; index < 1_000; index += 1) {
      relay.push({ chunk: "x".repeat(1_024), stream: "stdout" });
    }

    expect(relay.bufferedCount).toBe(0);
    expect(written).toEqual([]);
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
    relay.attach((chunk) => written.push(chunk.chunk));
    relay.push({ chunk: "after", stream: "stdout" });
    expect(written).toEqual([]);
  });
});
