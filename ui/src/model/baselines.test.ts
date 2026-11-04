import { describe, expect, it } from "vitest";

import type { BaselineEntry } from "../../../src/contract/index";
import { baselineRows } from "./baselines";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-11-03T12:00:00Z");

function entry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mode: "full",
    model: "Pixel 9",
    name: "checkout",
    osVersion: "36",
    platform: "android",
    savedAt: "2026-11-03T10:00:00Z",
    version: 2,
    ...overrides,
  };
}

function worker(id: string, label?: string): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: NOW,
    leases: [],
    ...(label === undefined ? {} : { label }),
  };
}

describe("baselineRows", () => {
  it("shows each entry's columns in the console's formats, ordered by name then worker", () => {
    const rows = baselineRows(
      [
        entry({
          imageTag: "google_apis",
          note: "app 4.2, test user",
          sizeBytes: 4.5 * 2 ** 30,
          workerId: "w2",
        }),
        entry({
          name: "login",
          platform: "ios",
          model: "iPhone 17",
          osVersion: "27.0",
          mode: "slim",
          version: 1,
          workerId: "w1",
        }),
        entry({ name: "checkout", workerId: "w1", sizeBytes: 300 * 2 ** 20 }),
        entry({ name: "alpha", workerId: "w9" }),
      ],
      [worker("w1", "mac-mini-2"), worker("w2", "mac-studio-1")],
      NOW,
    );

    expect(rows.map((row) => [row.name, row.worker])).toEqual([
      ["alpha", "w9"],
      ["checkout", "mac-mini-2"],
      ["checkout", "mac-studio-1"],
      ["login", "mac-mini-2"],
    ]);
    expect(rows[2]).toMatchObject({
      mode: "full",
      model: "Pixel 9 / google_apis",
      note: "app 4.2, test user",
      os: "36",
      platform: "Android",
      saved: "2 h ago",
      savedAt: "2026-11-03T10:00:00Z",
      size: "4.5 GiB",
      version: 2,
    });
    expect(rows[1]?.size).toBe("300 MiB");
    expect(rows[3]).toMatchObject({ model: "iPhone 17", platform: "iOS", note: "" });
  });

  it("leaves the worker out when no entry carries one, and shows an entry with no size as a dash", () => {
    const [row] = baselineRows([entry()], [], NOW);
    expect(row?.worker).toBeUndefined();
    expect(row?.size).toBe("—");
  });

  it("marks an entry with a stale reason stale, word for word", () => {
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed";
    const rows = baselineRows([entry({ staleReason: reason }), entry({ name: "ok" })], [], NOW);
    expect(rows.map((row) => row.stale)).toEqual([reason, undefined]);
  });
});
