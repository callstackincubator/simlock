import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiResponse } from "./api";
import { watchMode } from "./mode";
import { connect, fakeClock, settle } from "./live/test-support";

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

    const store = watchMode({ api: daemon, clock: fakeClock, connection });
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

describe("the daemon's version facts", () => {
  it("are read again every 10 minutes, kept when a re-read fails, and no longer read once the store is disposed", async () => {
    const { connection, daemon } = connect();
    let status: () => Promise<ApiResponse<unknown>> = () =>
      Promise.resolve({
        body: { daemon: { latestVersion: null, mode: "gateway", version: "0.3.0" } },
        date: null,
      });
    let statusReads = 0;
    daemon.reads = (path) =>
      path === "/v1/status"
        ? ((statusReads += 1), status())
        : Promise.resolve({ body: { workers: [] } as unknown, date: null });
    // why: a stream that never opens cannot reconnect, so only the 10-minute timer re-reads.
    daemon.holdStreams = true;
    const store = watchMode({ api: daemon, clock: fakeClock, connection });
    await settle();
    expect(store.daemon()).toEqual({ latestVersion: null, version: "0.3.0" });

    status = () =>
      Promise.resolve({
        body: { daemon: { latestVersion: "0.4.0", mode: "gateway", version: "0.3.0" } },
        date: null,
      });
    await vi.advanceTimersByTimeAsync(599_000);
    expect({ reads: statusReads, facts: store.daemon() }).toEqual({
      facts: { latestVersion: null, version: "0.3.0" },
      reads: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect({ reads: statusReads, facts: store.daemon(), mode: store.mode() }).toEqual({
      facts: { latestVersion: "0.4.0", version: "0.3.0" },
      mode: "gateway",
      reads: 2,
    });

    status = () => Promise.reject(new ApiError(503, "INTERNAL", "Busy"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect({ reads: statusReads, facts: store.daemon(), mode: store.mode() }).toEqual({
      facts: { latestVersion: "0.4.0", version: "0.3.0" },
      mode: "gateway",
      reads: 3,
    });

    const reading = (version: unknown) => () =>
      Promise.resolve({
        body: { daemon: { latestVersion: "0.4.0", mode: "gateway", version } },
        date: null,
      });
    status = reading("0.4.0");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(store.daemon()).toEqual({ latestVersion: "0.4.0", version: "0.4.0" });

    status = reading(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect({ reads: statusReads, facts: store.daemon() }).toEqual({
      facts: { latestVersion: "0.4.0" },
      reads: 5,
    });

    store.dispose();
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(statusReads).toBe(5);
  });
});
