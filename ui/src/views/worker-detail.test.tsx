import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkerDetail } from "./worker-detail";
import { WorkerFacts } from "./worker-facts";
import type { WorkerView } from "./workers-model";

// The leases panel reads the live connection, which a string render has none of; it has its own
// tests with the leases view.
vi.mock("./leases", () => ({ WorkerLeases: () => <p>the leases panel</p> }));

const NOW = Date.parse("2026-10-02T12:00:00Z");

const ENTRY = {
  atRamBudget: false,
  limit: 4,
  maxRunning: 4,
  overLimit: false,
  reserved: 0,
  running: 1,
  used: 1,
  warm: 0,
};

const RUNNING: WorkerView = {
  capacity: {
    android: { ...ENTRY, running: 0, used: 0 },
    global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
    ios: ENTRY,
  },
  catalog: [
    {
      classDefaults: {},
      defaultRuntime: "26.0",
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: {},
      models: ["iPhone 17"],
      platform: "ios",
      runtimes: ["26.0"],
    },
  ],
  connection: "connected",
  devices: [
    {
      id: "dev_1",
      mode: "full",
      servesDefaultMode: true,
      spec: { model: "iPhone 17", osVersion: "26.0", platform: "ios" },
      state: "ready",
    },
  ],
  drained: false,
  health: "running",
  host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
  id: "wrk_1",
  lastSeenAt: NOW,
  leases: [
    {
      deviceId: "dev_1",
      grantedAt: NOW,
      id: "l_1",
      lastRenewedAt: NOW,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: NOW + 60_000,
      ttlMs: 60_000,
    },
  ],
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detail(worker: WorkerView): string {
  return text(renderToStaticMarkup(<WorkerDetail id="wrk_1" workers={[worker]} now={NOW} />));
}

describe("the page of a worker that has finished starting", () => {
  it("shows its devices, leases, host, catalog and installs, and not the starting line", () => {
    const shown = detail(RUNNING);

    expect(shown).toContain("dev_1 ready");
    expect(shown).toContain("the leases panel");
    expect(shown).toContain("Operating system macOS 15.5");
    expect(shown).toContain("iOS Models: iPhone 17 Runtimes: 26.0 (default)");
    expect(shown).toContain("No installs in progress.");
    expect(shown).not.toContain("appear once startup finishes");
  });

  it("says so where a worker's catalog and devices were never read", () => {
    const { catalog: _catalog, devices: _devices, ...unread } = RUNNING;

    const shown = detail(unread);

    expect(shown).toContain("Nothing reported.");
    expect(shown).toContain("No devices.");
  });
});

describe("a worker's card once it has finished starting", () => {
  it("counts its devices and capacity, and says Not reported for what it has not read", () => {
    const shown = text(renderToStaticMarkup(<WorkerFacts worker={RUNNING} />));

    expect(shown).toContain("Health running");
    expect(shown).toContain("Devices 1 running, 1 leased");
    expect(shown).toContain("Capacity iOS 1 of 4 running, Android 0 of 4 running");

    const { capacity: _capacity, ...unread } = RUNNING;
    const unreadShown = text(renderToStaticMarkup(<WorkerFacts worker={unread} />));
    expect(unreadShown).toContain("Devices Not reported");
    expect(unreadShown).toContain("Capacity Not reported");
  });
});
