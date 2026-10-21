import { inConsole } from "../../state/test-support";
import { describe, expect, it } from "vitest";

import type { Paging } from "../../ds";
import {
  type FleetPage,
  type WorkerPageView,
  type WorkerTab,
  type WorkerView,
  workerPageOf,
  workerRow,
} from "../../state/workers";
import { FleetBody } from "./index";
import { WorkerPageBody } from "./worker-page";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const GIB = 1024 ** 3;

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

const WORKER: WorkerView = {
  capacity: {
    android: { ...ENTRY, running: 0, used: 0 },
    global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
    ios: ENTRY,
  },
  catalog: [],
  connection: "connected",
  devices: [
    {
      id: "dev_1",
      mode: "full",
      physical: false,
      servesDefaultMode: true,
      spec: { model: "iPhone 17", osVersion: "26.0", physical: false, platform: "ios" },
      state: "leased",
    },
  ],
  drained: false,
  health: "running",
  host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
  id: "wrk_1",
  label: "worker-a",
  lastSeenAt: NOW,
  leases: [
    {
      deviceId: "dev_1",
      grantedAt: NOW - 5_000,
      id: "l_1",
      idChosenByRequester: false,
      lastRenewedAt: NOW,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: NOW + 60_000,
      ttlMs: 65_000,
    },
  ],
  load: {
    cpu: { busyPercent: 28, cores: 12, limited: false },
    disk: { freeBytes: 112.4 * GIB, totalBytes: 494.4 * GIB },
    memory: {
      availableBytes: 20.9 * GIB,
      limited: false,
      pressure: "warn",
      swapUsedBytes: 1.2 * GIB,
      totalBytes: 36 * GIB,
    },
    readAt: NOW - 12_000,
  },
  version: "1.4.0",
};

const PAGING: Paging = {
  go: () => {},
  last: 1,
  page: 1,
  range: "1–1 of 1",
  resize: () => {},
  size: 25,
  sizes: [25],
  total: 1,
};

function fleet(
  workers: readonly WorkerView[],
  overrides: Partial<FleetPage> = {},
  filter: FleetPage["filter"] = "all",
): FleetPage {
  return {
    empty: workers.length === 0,
    filter,
    meta: "1 / 1 up",
    paging: PAGING,
    query: "",
    search: () => {},
    rows: workers.map((entry) => workerRow(entry)),
    setFilter: () => {},
    ...overrides,
  };
}

function page(worker: WorkerView, tab?: WorkerTab): WorkerPageView {
  return {
    ...workerPageOf({
      now: NOW,
      search: tab === undefined ? "" : `?tab=${tab}`,
      tokens: [],
      worker,
    }),
    back: "/fleet",
    chooseTab: () => {},
    devicesPaging: PAGING,
    warmPaging: PAGING,
  };
}

function html(view: WorkerPageView): string {
  return inConsole(<WorkerPageBody page={view} />);
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the fleet table", () => {
  it("says no workers have connected, or that none matches the filter", () => {
    const none = (empty: boolean, filter: FleetPage["filter"]) =>
      text(inConsole(<FleetBody page={fleet([], { empty }, filter)} />));

    expect(none(true, "all")).toContain("No workers have connected.");
    expect(none(false, "issues")).toContain("No worker matches.");
  });
});

describe("a worker's page", () => {
  it("is titled with the worker's name and reads its health word and operating system beneath", () => {
    const markup = html(page(WORKER));

    expect(markup).toMatch(/<h1[^>]*>worker-a<\/h1>/);
    expect(text(markup)).toContain("memory pressure warn · macOS 15.5");
  });

  it("states the load in the old panel's words, each beside a meter in its tone, with swap, pressure and the reading's age", () => {
    const shown = text(html(page(WORKER)));

    expect(shown).toContain("CPU 28% busy, 12 cores");
    expect(shown).toContain("Memory 20.9 GiB of 36.0 GiB available");
    expect(shown).toContain("Swap 1.2 GiB used");
    expect(shown).toContain("Pressure warn");
    expect(shown).toContain("Disk 112.4 GiB of 494.4 GiB free");
    expect(shown).toContain("Read 12 s ago");
    const markup = html(page(WORKER));
    expect(markup).toContain(
      'class="load-bar load-bar-warn meter-regular" aria-hidden="true" style="--load-bar:42%"',
    );
    expect(markup).toContain(
      'class="load-bar load-bar-neutral meter-regular" aria-hidden="true" style="--load-bar:28%"',
    );
  });

  it("counts the leases and draws a lg slots group with its legend for each platform", () => {
    const markup = html(page(WORKER));

    expect(text(markup)).toContain("Leases 1");
    expect(text(markup)).toContain("iOS 1 of 4 running");
    expect(text(markup)).toContain("Android 0 of 4 running");
    expect(markup).toContain(
      'class="slots slots-lg" role="img" aria-label="iOS: 1 leased, 3 free"',
    );
    expect(markup).toContain("slot-legend");
  });

  it("lists a leased device with its holder as a link to the lease, the time on it and what is left", () => {
    const markup = html(page(WORKER));

    expect(markup).toContain('href="/leases/l_1/"');
    expect(text(markup)).toContain("iPhone 17 26.0");
    expect(text(markup)).toContain("agent renewed 0 s ago");
    expect(text(markup)).toContain("5 s expires in 1 min");
    expect(text(markup)).toContain("Virtual");
    expect(markup).toContain('aria-label="leased"');
  });

  it("says No devices. for a worker whose devices were never read", () => {
    const { devices: _devices, ...unread } = WORKER;

    expect(text(html(page(unread)))).toContain("No devices.");
  });

  it("says No reading while disconnected in place of the load figures of a disconnected worker", () => {
    const shown = text(html(page({ ...WORKER, connection: "disconnected" })));

    expect(shown).toContain("No reading while disconnected");
    expect(shown).not.toContain("busy,");
  });

  it("shows a starting worker without devices, capacity or a warm pool tab", () => {
    const starting: WorkerView = {
      connection: "connected",
      drained: false,
      health: "starting",
      host: WORKER.host,
      id: "wrk_1",
      lastSeenAt: NOW,
    };

    const shown = text(html(page(starting)));

    expect(shown).toContain("Devices, leases and capacity appear once startup finishes.");
    expect(shown).not.toContain("Warm pool");
    expect(shown).not.toContain("No devices.");
    expect(shown).not.toContain("Capacity not reported.");
  });

  it("shows an incompatible worker's protocol ranges on its Host tab, and no devices or load", () => {
    const old: WorkerView = {
      connection: "incompatible",
      drained: false,
      id: "wrk_old",
      label: "old-worker",
      lastSeenAt: NOW,
      protocol: { gateway: { max: 35, min: 35 }, worker: { max: 30, min: 30 } },
    };

    const devicesMarkup = html(page(old));
    const devices = text(devicesMarkup);
    const host = text(html(page(old, "host")));

    expect(devices).toContain("No devices: the gateway cannot read this worker.");
    expect(devices).not.toContain("Read ");
    expect(devicesMarkup).not.toContain("Load and leases");
    expect(host).toContain("incompatible gateway 35–35, worker 30–30");
  });
});

describe("a worker's host and warm pool tabs", () => {
  it("shows the machine, tools, protocol, capabilities with their reasons, and the catalog", () => {
    const view: WorkerView = {
      ...WORKER,
      capabilities: [
        { name: "agent-device", state: "available" },
        { name: "stream", reason: "found 0.20.1, need 0.21.28 or later", state: "unavailable" },
      ],
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
      host: {
        arch: "arm64",
        os: "macOS",
        osVersion: "15.5",
        tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
      },
    };

    const markup = html(page(view, "host"));
    const shown = text(markup);

    expect(shown).toContain("Operating system macOS 15.5");
    expect(shown).toContain("CPU architecture arm64");
    expect(shown).toContain("xcode 16.4 (16F6) for iOS");
    expect(shown).toContain("Protocol compatible");
    expect(shown).toContain("agent-device available");
    expect(shown).toContain("stream unavailable found 0.20.1, need 0.21.28 or later");
    expect(shown).toContain("iOS Models: iPhone 17 Runtimes: 26.0 (default)");
    expect(markup).toContain("status-ok");
    expect(markup).toContain("status-warn");
  });

  it("shows the warm pool's facts, its targets table and the installs in progress", () => {
    const view: WorkerView = {
      ...WORKER,
      installs: [
        {
          component: "19.0",
          platform: "ios",
          since: NOW - 7_000,
          state: "downloading",
          waiters: 1,
        },
      ],
      warmPool: {
        enabled: true,
        reserveRunning: { android: 0, ios: 1 },
        targets: [
          {
            booting: 1,
            count: 2,
            mode: "full",
            model: "iPhone 17",
            origin: "configured",
            osVersion: "26.0",
            platform: "ios",
            ready: 1,
          },
          {
            booting: 0,
            count: 1,
            mode: "full",
            model: "iPhone 17",
            origin: "learned",
            platform: "ios",
            ready: 0,
            short: "runtime-missing",
          },
          {
            booting: 0,
            count: 1,
            imageTag: "google_apis_playstore",
            mode: "full",
            model: "Pixel 8",
            origin: "learned",
            osVersion: "35",
            platform: "android",
            ready: 1,
          },
        ],
      },
    };

    const markup = html(page(view, "warm-pool"));
    const shown = text(markup);

    expect(shown).toContain("Pool On");
    expect(shown).toContain("Reserved running slots iOS 1, Android 0");
    expect(shown).toContain("Origin");
    expect(shown).toContain("iPhone 17 26.0 full configured 2 1 1 —");
    expect(shown).toContain("iPhone 17 — full learned 1 0 0 runtime-missing");
    expect(shown).toContain("Pixel 8 / google_apis_playstore 35 full learned 1 1 0 —");
    expect(shown).toContain("iOS 19.0 downloading for 7 s , 1 waiter");
    expect(markup).toContain('<td data-label="Wanted" class="num">2</td>');
  });

  it("says Not reported. for a pool the worker has not reported and No installs in progress. for none", () => {
    const markup = html(page(WORKER, "warm-pool"));
    const shown = text(markup);

    expect(markup).toContain('<p class="muted">Not reported.</p>');
    expect(shown).toContain("No installs in progress.");
  });
});
