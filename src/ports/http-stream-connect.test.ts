import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets: { request: EventEmitter & { destroy(error: Error): void } }[] = [];

// why: a connection that never completes cannot be made on a test machine on demand, so `node:http` is replaced by a request whose socket stays connecting; the 10 s bound is then read off a fake clock.
vi.mock("node:http", () => ({
  request: () => {
    const request = Object.assign(new EventEmitter(), {
      destroy(error: Error) {
        request.emit("error", error);
        request.emit("close");
      },
      end() {
        const socket = Object.assign(new EventEmitter(), { connecting: true });
        request.emit("socket", socket);
      },
    });
    sockets.push({ request });
    return request;
  },
}));

const { NodeHttpStreamClient } = await import("./http-stream.js");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  sockets.length = 0;
});

describe("NodeHttpStreamClient's connect bound", () => {
  it("rejects a connection not made after 10 s, not before", async () => {
    let settled = false;
    const call = new NodeHttpStreamClient().request({
      method: "GET",
      signal: new AbortController().signal,
      token: "t",
      url: "http://192.0.2.1/x",
    });
    call.catch(() => undefined).finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled, "after 9.999 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, "at 10 s").toBe(true);
    await expect(call).rejects.toThrow("The connection was not made in time");
  });
});
