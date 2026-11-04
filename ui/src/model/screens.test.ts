import { expect, it } from "vitest";

import { screenNotice, screensOf } from "./screens";
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
