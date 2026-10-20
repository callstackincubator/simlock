import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageOutput } from "../../contract/index.js";
import { createUsageReader } from "./index.js";

const made = vi.hoisted(() => [] as unknown[]);

vi.mock("node:worker_threads", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class FakeWorker extends Emitter {
    readonly requests: { id: number }[] = [];
    unref(): void {}
    postMessage(request: { id: number }): void {
      this.requests.push(request);
    }
    terminate(): Promise<number> {
      return Promise.resolve(1);
    }
    constructor() {
      super();
      made.push(this);
    }
  }
  return { Worker: FakeWorker };
});

type Fake = EventEmitter & { readonly requests: { id: number }[] };

beforeEach(() => {
  made.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("usage reader: a read thread that did not answer", () => {
  it("answers a get made after a timed-out read from the new thread, though the dropped thread's exit arrives after that get", async () => {
    const reader = createUsageReader({
      historyPath: "/unused",
      opened: () => true,
      tokenLabels: async () => new Map(),
      workers: () => [],
    });
    const first = reader.get({ from: 0, to: 60_000 });
    const rejected = expect(first).rejects.toThrow("did not answer in time");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    const second = reader.get({ from: 0, to: 120_000 });
    const [oldThread, newThread] = made as Fake[];
    expect(made).toHaveLength(2);
    oldThread?.emit("exit", 1);
    const figures = { requesters: [] } as unknown as UsageOutput;
    newThread?.emit("message", { figures, id: newThread.requests[0]?.id });

    await expect(second).resolves.toEqual({ kind: "figures", usage: figures });
  });
});
