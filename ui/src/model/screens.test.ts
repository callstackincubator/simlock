import { expect, it } from "vitest";

import { createCaptureBudget, screenNotice, screensOf } from "./screens";
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

it("shows only running devices, preserves cross-worker identities and stable order, and explains unavailable streams", () => {
  const a = worker("a");
  const b = worker("b", ["ready"]);
  const rows = screensOf([b, a]);
  expect(rows.map((row) => row.key)).toEqual(['["a","dev_0"]', '["a","dev_1"]', '["b","dev_0"]']);
  expect(screensOf([a, b])).toEqual(rows);
  expect(rows[0]).toMatchObject({
    label: "iPhone",
    worker: "Host a",
    runtime: "18.4",
    platform: "iOS",
    to: "/fleet/a/dev_0?drawer=screen",
  });
  expect(screensOf([])).toEqual([]);
  expect(screensOf([{ ...a, connection: "disconnected" }])[0]?.offer).toEqual({
    offered: false,
    reason: "Host a is disconnected.",
  });
  expect(screensOf([{ ...a, capabilities: [] }])[0]?.offer).toEqual({
    offered: false,
    reason: "Streaming is off on Host a.",
  });
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
      expected: "Paused while out of view.",
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
