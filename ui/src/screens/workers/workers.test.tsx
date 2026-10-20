import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Paging } from "../../ds";
import {
  type WorkersPage,
  type WorkerTab,
  type WorkerView,
  workerInspectorOf,
  workerRow,
} from "../../state/workers";
import { WorkersBody } from "./index";

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

function page(
  worker: WorkerView | undefined,
  overrides: Partial<WorkersPage> = {},
  workers: readonly WorkerView[] = worker === undefined ? [] : [worker],
): WorkersPage {
  return {
    chosen: worker?.id,
    empty: workers.length === 0,
    filter: "all",
    focus: "detail",
    inspector:
      worker === undefined
        ? undefined
        : {
            ...workerInspectorOf({ now: NOW, tokens: [], worker }),
            devicesPaging: PAGING,
            warmPaging: PAGING,
          },
    meta: "1 / 1 up",
    missing: undefined,
    paging: PAGING,
    rows: workers.map((entry) => workerRow(entry)),
    setFilter: () => {},
    ...overrides,
  };
}

function html(view: WorkersPage, tab?: WorkerTab): string {
  return renderToStaticMarkup(
    <WorkersBody page={view} {...(tab === undefined ? {} : { initialTab: tab })} />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the workers list", () => {
  it("shows a row as a square named by its health word, the worker's name and running over limit, with no warning word in it", () => {
    const drained = { ...WORKER, drained: true, load: undefined };

    const markup = html(page(drained));
    const row = markup.slice(markup.indexOf('class="list"'), markup.indexOf("</ul>"));

    expect(row).toContain('aria-label="drained"');
    expect(row).toContain("status-dot-warn");
    expect(text(row)).toContain("worker-a 1 / 8");
    expect(text(row)).not.toMatch(/drained|memory|disconnected/);
  });

  it("heads the list with how many workers are up and offers the three filters", () => {
    const markup = html(page(WORKER));

    expect(text(markup)).toContain("Fleet 1 / 1 up");
    for (const label of ["All", "Issues", "Busy"]) expect(text(markup)).toContain(label);
    expect(markup).toContain('value="issues"');
  });

  it("draws a thin neutral meter under a worker that reported its capacity and none under one that did not", () => {
    const lost = { ...WORKER, connection: "disconnected" as const };

    expect(html(page(WORKER))).toContain("load-bar-neutral meter-thin");
    expect(html(page(lost))).not.toContain("meter-thin");
    expect(text(html(page(lost)))).toContain("worker-a —");
  });

  it("marks the chosen row as the current page", () => {
    expect(html(page(WORKER))).toContain('aria-current="page"');
  });

  it("says no workers have connected, or that none matches the filter", () => {
    expect(text(html(page(undefined, { empty: true })))).toContain("No workers have connected.");
    expect(text(html(page(undefined, { empty: false, filter: "issues" })))).toContain(
      "No worker matches.",
    );
  });
});

describe("a worker's inspector", () => {
  it("is titled with the worker's name and reads its health word, operating system and version beneath", () => {
    const markup = html(page(WORKER));

    expect(markup).toMatch(/<h2[^>]*>worker-a<\/h2>/);
    expect(text(markup)).toContain("memory pressure warn · macOS 15.5 · 1.4.0");
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
  });

  it("shows an incompatible worker's protocol ranges on its overview", () => {
    const old: WorkerView = {
      connection: "incompatible",
      drained: false,
      id: "wrk_old",
      label: "old-worker",
      lastSeenAt: NOW,
      protocol: { gateway: { max: 35, min: 35 }, worker: { max: 30, min: 30 } },
    };

    const shown = text(html(page(old)));

    expect(shown).toContain("incompatible gateway 35–35, worker 30–30");
    expect(shown).not.toContain("Read ");
  });

  it("says that no worker has the id in the URL, with a link back to the list", () => {
    const markup = html(page(undefined, { missing: "wrk_nope" }, [WORKER]));

    expect(text(markup)).toContain("Worker not found. Back to Fleet");
    expect(markup).toContain('href="/fleet"');
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

    const markup = html(page(view), "host");
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
            osVersion: "26.0",
            platform: "ios",
            ready: 1,
          },
          {
            booting: 0,
            count: 1,
            mode: "full",
            model: "iPhone 17",
            platform: "ios",
            ready: 0,
            short: "runtime-missing",
          },
        ],
      },
    };

    const markup = html(page(view), "warm-pool");
    const shown = text(markup);

    expect(shown).toContain("Pool On");
    expect(shown).toContain("Reserved running slots iOS 1, Android 0");
    expect(shown).toContain("iPhone 17 26.0 full 2 1 1 —");
    expect(shown).toContain("iPhone 17 — full 1 0 0 runtime-missing");
    expect(shown).toContain("iOS 19.0 downloading for 7 s , 1 waiter");
    expect(markup).toContain('<td data-label="Wanted" class="num">2</td>');
  });

  it("says Not reported. for a pool the worker has not reported and No installs in progress. for none", () => {
    const shown = text(html(page(WORKER), "warm-pool"));

    expect(shown).toContain("Not reported.");
    expect(shown).toContain("No installs in progress.");
  });
});
