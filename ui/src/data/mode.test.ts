import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiResponse } from "./api";
import { watchMode } from "./mode";
import { connect, settle } from "./live/test-support";

afterEach(() => {
  vi.useRealTimers();
});

describe("the daemon's mode", () => {
  it("is kept as gateway or worker after a good read, as none after a failed one, and read again after a reconnect", async () => {
    const { connection, daemon } = connect();
    let status: () => Promise<ApiResponse<unknown>> = () =>
      Promise.resolve({ body: { daemon: { mode: "gateway" } }, date: null });
    let statusReads = 0;
    daemon.reads = (path) =>
      path === "/v1/status"
        ? ((statusReads += 1), status())
        : Promise.resolve({ body: { workers: [] } as unknown, date: null });
    const seen: unknown[] = [];

    const store = watchMode({ api: daemon, connection });
    store.subscribe(() => seen.push(store.mode()));
    await settle();
    expect(store.mode()).toBe("gateway");
    expect(statusReads).toBe(1);

    const reconnect = async () => {
      daemon.openStream()?.end();
      await vi.advanceTimersByTimeAsync(2_000);
    };
    status = () => Promise.resolve({ body: { daemon: { mode: "worker" } }, date: null });
    await reconnect();
    expect(store.mode()).toBe("worker");

    status = () => Promise.reject(new ApiError(503, "INTERNAL", "Busy"));
    await reconnect();
    expect(store.mode()).toBeUndefined();

    status = () => Promise.resolve({ body: { daemon: { mode: "elsewhere" } }, date: null });
    await reconnect();
    expect(store.mode()).toBeUndefined();

    status = () => Promise.resolve({ body: { daemon: { mode: "gateway" } }, date: null });
    await reconnect();
    expect(store.mode()).toBe("gateway");
    expect(seen).toEqual(["gateway", "worker", undefined, "gateway"]);
  });
});
