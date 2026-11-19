import { expect, it } from "vitest";

import {
  createCaptureBudget,
  filterScreens,
  readWatch,
  screenNotice,
  screensOf,
  watchedOf,
  writeWatch,
} from "./screens";
import type { WorkerDevice, WorkerView } from "./workers";

function worker(
  id: string,
  states = ["ready", "leased", "shutdown", "provisioning", "absent"],
): WorkerView {
  return {
    id,
    label: `Host ${id}`,
    connection: "connected",
    drained: false,
    lastSeenAt: 0,
    capabilities: [{ name: "stream", state: "available" }],
    devices: states.map(
      (state, index) =>
        ({
          id: `dev_${index}`,
          physical: false,
          spec: { platform: "ios", model: "iPhone", osVersion: "18.4" },
          state,
        }) as WorkerDevice,
    ),
  };
}

const NOW = 1_000_000;

function lease(deviceId: string, requesterId: string, grantedAt: number) {
  return {
    id: `lse_${deviceId}`,
    deviceId,
    requesterId,
    ownerId: requesterId,
    grantedAt,
    ttlMs: 60_000,
    ttlDeadline: grantedAt + 60_000,
    lastRenewedAt: grantedAt,
    idChosenByRequester: false,
  };
}

it("lists running devices with leased ones first by holder, and explains unavailable streams", () => {
  const a = { ...worker("a"), leases: [lease("dev_1", "codex:zeta", NOW - 125_000)] };
  const b = {
    ...worker("b", ["leased", "ready"]),
    leases: [lease("dev_0", "claude-code:alpha", NOW - 5_000)],
  };
  const rows = screensOf([b, a], NOW);
  expect(rows.map((row) => row.key)).toEqual([
    '["b","dev_0"]',
    '["a","dev_1"]',
    '["a","dev_0"]',
    '["b","dev_1"]',
  ]);
  expect(screensOf([a, b], NOW)).toEqual(rows);
  expect(rows[1]).toMatchObject({
    label: "iPhone",
    worker: "Host a",
    runtime: "18.4",
    platform: "iOS",
    state: { word: "leased", tone: "ok" },
    holder: { short: "codex:zeta", full: "codex:zeta" },
    leasedFor: "2 min 5 s",
    to: "/fleet/a/devices/dev_1/",
  });
  expect(rows[2]?.holder).toBeUndefined();
  expect(rows[2]?.leasedFor).toBeUndefined();
  expect(screensOf([], NOW)).toEqual([]);
  expect(screensOf([{ ...a, connection: "disconnected" }], NOW)[0]?.offer).toEqual({
    offered: false,
    reason: "Host a is disconnected.",
  });
  expect(screensOf([{ ...a, capabilities: [] }], NOW)[0]?.offer).toEqual({
    offered: false,
    reason: "Streaming is off on Host a.",
  });
});

it("filters by state", () => {
  const rows = screensOf([worker("a")], NOW);
  expect(filterScreens(rows, "leased").map((row) => row.state.word)).toEqual(["leased"]);
  expect(filterScreens(rows, "ready").map((row) => row.state.word)).toEqual(["ready"]);
  expect(filterScreens(rows, "all")).toHaveLength(2);
});

it("keeps the watched devices in the address and shows at most four that are still running", () => {
  const keys = ['["a","dev_0"]', '["a","dev_1"]', '["a","gone"]'];
  const search = writeWatch("?page=2", keys);
  expect(readWatch(search)).toEqual(keys);
  expect(new URLSearchParams(search).get("page")).toBe("2");
  expect(writeWatch(search, [])).toBe("?page=2");
  expect(writeWatch("", [])).toBe("");
  expect(readWatch(writeWatch("", ["1", "2", "3", "4", "5"]))).toEqual(["1", "2", "3", "4"]);
  const five = screensOf([worker("a", ["ready", "ready", "ready", "ready", "ready"])], NOW);
  expect(watchedOf(five, ['["a","gone"]', ...five.map((row) => row.key)])).toEqual(
    five.slice(0, 4),
  );
  expect(readWatch("?watch=1&watch=1")).toEqual(["1"]);
  const rows = screensOf([worker("a")], NOW);
  expect(watchedOf(rows, [keys[1]!, keys[2]!, keys[0]!]).map((row) => row.key)).toEqual([
    keys[1],
    keys[0],
  ]);
});

it("prioritizes daemon loss, unavailable offers and visibility before showing a picture", () => {
  const cases = [
    {
      connected: false,
      offer: { offered: false, reason: "Worker unavailable." },
      active: true,
      expected: "Disconnected from the daemon.",
    },
    {
      connected: false,
      offer: { offered: true },
      active: false,
      expected: "Disconnected from the daemon.",
    },
    {
      connected: true,
      offer: { offered: false, reason: "Worker unavailable." },
      active: true,
      expected: "Worker unavailable.",
    },
    {
      connected: true,
      offer: { offered: false, reason: "Worker unavailable." },
      active: false,
      expected: "Worker unavailable.",
    },
    {
      connected: true,
      offer: { offered: false },
      active: true,
      expected: "Streaming is unavailable.",
    },
    { connected: true, offer: { offered: false, reason: "" }, active: true, expected: "" },
    {
      connected: true,
      offer: { offered: true, reason: "Ignored for an available offer." },
      active: true,
      expected: undefined,
    },
    {
      connected: true,
      offer: { offered: true },
      active: false,
      expected: "Paused while this tab is hidden.",
    },
  ];
  for (const { expected, ...input } of cases) expect(screenNotice(input)).toBe(expected);
});

it("does not give an already aborted request a capture slot", async () => {
  const acquire = createCaptureBudget();
  const canceled = new AbortController();
  canceled.abort();
  expect(await acquire(canceled.signal)).toBeUndefined();
  const releases: (() => void)[] = [];
  for (let index = 0; index < 4; index++)
    void acquire(new AbortController().signal).then((release) => {
      if (release !== undefined) releases.push(release);
    });
  await Promise.resolve();
  expect(releases).toHaveLength(4);
  for (const release of releases) release();
});

it("cancels a waiting request without stealing the next released slot", async () => {
  const acquire = createCaptureBudget();
  const owners = await Promise.all(
    Array.from({ length: 4 }, () => acquire(new AbortController().signal)),
  );
  const canceled = new AbortController();
  let outcome: unknown = "pending";
  void acquire(canceled.signal).then((release) => {
    outcome = release;
  });
  canceled.abort();
  await Promise.resolve();
  expect(outcome).toBeUndefined();
  let next: (() => void) | undefined;
  void acquire(new AbortController().signal).then((release) => {
    next = release;
  });
  expect(owners.every((release) => typeof release === "function")).toBe(true);
  owners[0]!();
  await Promise.resolve();
  expect(typeof next).toBe("function");
  for (const release of owners) release!();
  next!();
});

it("admits waiting capture requests in arrival order", async () => {
  const acquire = createCaptureBudget();
  const owners = await Promise.all(
    Array.from({ length: 4 }, () => acquire(new AbortController().signal)),
  );
  const admitted: string[] = [];
  const releases: (() => void)[] = [];
  for (const id of ["first", "second"])
    void acquire(new AbortController().signal).then((release) => {
      if (release !== undefined) {
        admitted.push(id);
        releases.push(release);
      }
    });
  await Promise.resolve();
  expect(admitted).toEqual([]);
  owners[0]!();
  await Promise.resolve();
  expect(admitted).toEqual(["first"]);
  owners[1]!();
  await Promise.resolve();
  expect(admitted).toEqual(["first", "second"]);
  for (const release of owners) release!();
  for (const release of releases) release();
});

it("releasing the same capture twice gives only one waiting request a slot", async () => {
  const acquire = createCaptureBudget();
  const owners = await Promise.all(
    Array.from({ length: 4 }, () => acquire(new AbortController().signal)),
  );
  const releases: (() => void)[] = [];
  for (let index = 0; index < 2; index++)
    void acquire(new AbortController().signal).then((release) => {
      if (release !== undefined) releases.push(release);
    });
  owners[0]!();
  owners[0]!();
  await Promise.resolve();
  expect(releases).toHaveLength(1);
  owners[1]!();
  await Promise.resolve();
  expect(releases).toHaveLength(2);
  for (const release of owners) release!();
  for (const release of releases) release();
});
