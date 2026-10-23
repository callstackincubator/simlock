import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiPath } from "../data/api";
import { connect, fakeClock, settle } from "../data/live/test-support";
import { createQueries, type Queries } from "./queries";

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

function start() {
  const live = connect();
  const queries: Queries = createQueries({
    clock: fakeClock,
    connection: live.connection,
    visibility: live.visibility,
  });
  disposers.push(() => {
    queries.dispose();
    live.connection.dispose();
  });
  const watch = (path: ApiPath) =>
    new QueryObserver(queries.client, queries.options(path)).subscribe(() => undefined);
  const reads = (path: ApiPath) => live.daemon.gets.filter((get) => get.path === path).length;
  return { ...live, queries, reads, watch };
}

describe("the query layer", () => {
  it("a page on screen polls its keys; leaving or hiding stops it", async () => {
    const intervals = [
      ["/v1/lease-requests", 5_000],
      ["/v1/leases", 10_000],
      ["/v1/leases/l_1", 10_000],
      ["/v1/workers", 15_000],
      ["/v1/stats?since=1h", 60_000],
    ] as const;
    for (const [path, every] of intervals) {
      const { reads, watch } = start();
      const leave = watch(path);
      await settle();
      expect(reads(path), `${path} first read`).toBe(1);
      await vi.advanceTimersByTimeAsync(every - 1);
      expect(reads(path), `${path} just before ${every}`).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads(path), `${path} at ${every}`).toBe(2);
      await vi.advanceTimersByTimeAsync(every);
      expect(reads(path), `${path} at twice ${every}`).toBe(3);

      leave();
      await vi.advanceTimersByTimeAsync(every * 3);
      expect(reads(path), `${path} after leaving`).toBe(3);
    }

    const { reads: tokenReads, watch: watchTokens } = start();
    watchTokens("/v1/tokens");
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tokenReads("/v1/tokens"), "tokens are read once and never polled").toBe(1);

    const { daemon, visibility, watch: watchPage } = start();
    watchPage("/v1/workers");
    watchPage("/v1/leases");
    await settle();
    expect(daemon.gets).toHaveLength(2);

    visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.gets, "hidden").toHaveLength(2);

    visibility.set(false);
    await settle();
    expect(
      daemon.gets
        .map((get) => get.path)
        .slice(2)
        .sort(),
    ).toEqual(["/v1/leases", "/v1/workers"]);

    daemon.health = "down";
    daemon.openStream()?.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(daemon.gets, "disconnected").toHaveLength(4);

    daemon.health = "up";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      daemon.gets
        .map((get) => get.path)
        .slice(4)
        .sort(),
    ).toEqual(["/v1/leases", "/v1/workers"]);
  });
});
