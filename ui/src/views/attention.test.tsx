import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttentionList } from "./attention";
import { attentionItems } from "./attention-model";
import type { WorkerDevice, WorkerView } from "./workers-model";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const GIB = 1024 ** 3;

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function device(id: string, overrides: Partial<WorkerDevice> = {}): WorkerDevice {
  return {
    id,
    mode: "full",
    spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
    state: "ready",
    ...overrides,
  };
}

function capacity(ramBudget?: { usedBytes: number; limitBytes: number; overLimit: boolean }) {
  const entry = { limit: 4, maxRunning: 4, overLimit: false, reserved: 0, running: 1, used: 1 };
  return {
    android: { ...entry, warm: 0 },
    global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
    ios: { ...entry, warm: 0 },
    ...(ramBudget === undefined ? {} : { ramBudget }),
  };
}

/** Each item as `<worker id> <device id or -> <condition>`, the facts a test compares. */
function summary(workers: readonly WorkerView[]): string[] {
  return attentionItems(workers).map((item) =>
    [item.worker.id, "device" in item ? item.device.id : "-", item.condition].join(" "),
  );
}

/** The text a screen shows, without markup. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the attention list", () => {
  it("the attention list holds a disconnected, an incompatible and a drained worker", () => {
    const workers = [
      worker({ id: "wrk_ok" }),
      worker({ connection: "disconnected", id: "wrk_gone" }),
      worker({ connection: "incompatible", id: "wrk_old" }),
      worker({ drained: true, id: "wrk_drained" }),
      // Both at once are two items: each clears on its own.
      worker({ connection: "disconnected", drained: true, id: "wrk_both" }),
    ];

    expect(summary(workers)).toEqual([
      "wrk_gone - disconnected",
      "wrk_old - incompatible",
      "wrk_drained - drained",
      "wrk_both - disconnected",
      "wrk_both - drained",
    ]);
  });

  it("the attention list holds a quarantined device and a stalled device", () => {
    const workers = [
      worker({
        devices: [
          device("dev_ready"),
          device("dev_quarantined", { state: "quarantined" }),
          device("dev_stuck", { stalled: true, state: "reclaiming", transitionAgeMs: 300_000 }),
          // Mid-transition but not stalled: in progress, not a problem.
          device("dev_busy", { state: "provisioning", transitionAgeMs: 2_000 }),
        ],
      }),
    ];

    expect(summary(workers)).toEqual([
      "wrk_1 dev_quarantined quarantined",
      "wrk_1 dev_stuck stalled",
    ]);
  });

  it("the attention list holds a worker over its RAM budget", () => {
    const workers = [
      worker({
        capacity: capacity({ limitBytes: 12 * GIB, overLimit: true, usedBytes: 13 * GIB }),
        id: "wrk_over",
      }),
      worker({
        capacity: capacity({ limitBytes: 12 * GIB, overLimit: false, usedBytes: 4 * GIB }),
        id: "wrk_under",
      }),
      // No RAM budget kept, or capacity never read: nothing to be over.
      worker({ capacity: capacity(), id: "wrk_none" }),
      worker({ id: "wrk_unread" }),
    ];

    expect(summary(workers)).toEqual(["wrk_over - over RAM budget"]);
    const shown = text(
      renderToStaticMarkup(<AttentionList items={attentionItems(workers)} now={NOW} />),
    );
    expect(shown).toBe("over RAM budget wrk_over : 13.00 GiB of 12.00 GiB used.");
  });

  it("an item leaves the attention list when its condition clears", () => {
    const quarantined = device("dev_1", { state: "quarantined" });
    const stalled = device("dev_2", { stalled: true, state: "provisioning" });
    const ramBudget = { limitBytes: 12 * GIB, usedBytes: 13 * GIB };
    const over = capacity({ ...ramBudget, overLimit: true });
    const before = worker({
      capacity: over,
      connection: "disconnected",
      devices: [quarantined, stalled],
      drained: true,
    });
    expect(attentionItems([before])).toHaveLength(5);

    const cleared: [string, WorkerView][] = [
      ["disconnected", { ...before, connection: "connected" }],
      ["drained", { ...before, drained: false }],
      ["over RAM budget", { ...before, capacity: capacity({ ...ramBudget, overLimit: false }) }],
      ["quarantined", { ...before, devices: [{ ...quarantined, state: "ready" }, stalled] }],
      ["stalled", { ...before, devices: [quarantined, device("dev_2", { state: "ready" })] }],
    ];
    for (const [condition, after] of cleared) {
      const conditions = attentionItems([after]).map((item) => item.condition);
      expect(conditions, condition).toHaveLength(4);
      expect(conditions, condition).not.toContain(condition);
    }
  });

  it("each item names its worker and links to its page", () => {
    const workers = [
      worker({ connection: "disconnected", id: "wrk/1", label: "mac-mini-1" }),
      worker({
        devices: [
          device("dev_stuck", { stalled: true, state: "provisioning", transitionAgeMs: 90_000 }),
        ],
        id: "wrk_2",
        lastSeenAt: NOW - 10_000,
      }),
    ];

    const html = renderToStaticMarkup(<AttentionList items={attentionItems(workers)} now={NOW} />);

    expect(html).toContain('<a href="/workers/wrk%2F1">mac-mini-1</a>');
    expect(html).toContain('<a href="/workers/wrk_2">wrk_2</a>');
    expect(text(html)).toContain(
      "disconnected mac-mini-1 : the gateway has lost its connection to this worker.",
    );
    // 90 s in when the worker answered, 10 s ago.
    expect(text(html)).toContain(
      "stalled Device dev_stuck on wrk_2 : stuck provisioning for 1 min 40 s.",
    );
  });

  it("says so when nothing needs attention", () => {
    const html = renderToStaticMarkup(<AttentionList items={[]} now={NOW} />);

    expect(text(html)).toBe("Nothing needs attention.");
  });
});
