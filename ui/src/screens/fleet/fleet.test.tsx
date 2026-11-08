import { inConsole } from "../../state/test-support";
import { describe, expect, it } from "vitest";

import type { LoadView, Paging } from "../../ds";
import {
  type LogEventRow,
  type FleetPage,
  type WorkerEventsPage,
  type WorkerPageView,
  type WorkerTab,
  type WorkerView,
  fleetRow,
  workerPageOf,
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
  const rows = workers.map((entry) => fleetRow(entry, "", NOW));
  return {
    attention: rows.filter((row) => row.health.tone !== "ok"),
    empty: workers.length === 0,
    filter,
    healthy: rows.filter((row) => row.health.tone === "ok"),
    query: "",
    search: () => {},
    setFilter: () => {},
    ...overrides,
  };
}

const EVENT: LogEventRow = {
  detail: "no heartbeat for 30 s",
  id: "evt_1",
  iso: "2026-10-02T12:00:00.000Z",
  name: "worker.disconnected",
  squareTone: "error",
  subject: "worker-a",
  summary: "worker-a · no heartbeat for 30 s",
  time: "12:00:00",
  to: "/activity/evt_1",
  tone: "error",
};

const NO_LOG: LoadView<{ readonly rows: readonly LogEventRow[] }> = {
  data: { rows: [] },
  kind: "ready",
};

const NO_EVENTS: LoadView<WorkerEventsPage> = {
  data: { end: undefined, loadOlder: () => {}, rows: [] },
  kind: "ready",
};

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
    streamTo: (deviceId) => `/fleet/wrk_1/devices/${deviceId}`,
    warmPaging: PAGING,
  };
}

function html(view: WorkerPageView): string {
  return inConsole(<WorkerPageBody page={view} log={NO_EVENTS} />);
}

const GATEWAY = { mode: () => "gateway" as const };
const UPDATE = { forced: false, from: "1.4.0", leases: 2, startedAt: NOW, to: "1.5.0" };

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function fleetHtml(workers: readonly WorkerView[], filter: FleetPage["filter"] = "all"): string {
  return inConsole(<FleetBody page={fleet(workers, {}, filter)} log={NO_LOG} />);
}

const DRAINED: WorkerView = { ...WORKER, drained: true, id: "wrk_2", label: "worker-b" };
const GONE: WorkerView = {
  ...WORKER,
  connection: "disconnected",
  id: "wrk_3",
  label: "worker-c",
  lastSeenAt: NOW - 14 * 60_000,
};

describe("the fleet", () => {
  it("says no workers have connected, or that none matches the filter", () => {
    const none = (empty: boolean, filter: FleetPage["filter"]) =>
      text(inConsole(<FleetBody page={fleet([], { empty }, filter)} log={NO_LOG} />));

    expect(none(true, "all")).toContain("No workers have connected.");
    expect(none(false, "issues")).toContain("No worker matches.");
  });

  it("draws the fleet as one table grouped under Needs attention and Healthy, one row a worker", () => {
    const markup = fleetHtml([WORKER, DRAINED, GONE]);
    const shown = text(markup);

    expect(shown).toContain("Needs attention 3");
    expect(shown).not.toContain("Healthy");
    expect(markup).not.toContain("fleet-card");
    expect(markup.match(/<tr class="row-(warn|error)"/g)).toHaveLength(3);
    expect(markup).toContain('<tr class="row-error"');
    expect(markup).toContain("table-lines");
    expect(shown).toContain("Worker State Slots CPU Mem Disk Leases");
    // why: the reason is in the pill's hover, not in the cell, which holds only the pill.
    expect(shown).not.toContain("accepts no new requests");
    expect(fleetRow(DRAINED, "", NOW).reason).toContain("1 lease left · accepts no new requests");
    expect(fleetRow(GONE, "", NOW).reason).toBe("last seen 14 min ago · 1 lease held");
    const healthy = fleetHtml([{ ...WORKER, load: undefined }]);
    expect(text(healthy)).toContain("Healthy 1");
    expect(text(healthy)).toContain("worker-a macOS 15.5");
    expect(healthy).not.toContain("row-warn");
    expect(healthy).not.toContain("row-error");
  });

  it("gives each row its slots, its three meters and its lease count", () => {
    const markup = fleetHtml([DRAINED]);

    expect(markup).toContain('aria-label="1 leased, 7 free"');
    expect(markup).toContain("--load-bar:28%");
    expect(text(markup)).toContain("28% 42% 77% 1");
    expect(markup).toContain('title="worker-b"');
  });

  it("offers View leases as a plain link for a disconnected worker, and the drained worker's Undrain only on a gateway", () => {
    const gone = fleetHtml([GONE]);
    const drained = fleetHtml([DRAINED]);

    // why: both actions sit in the row's menu, which is drawn only when opened.
    expect(gone).not.toContain("View leases");
    expect(gone).not.toContain("<form");
    expect(drained).toContain('href="/fleet/wrk_2"');
    expect(drained).not.toContain("Undrain");
    const onGateway = inConsole(<FleetBody page={fleet([DRAINED])} log={NO_LOG} />, GATEWAY);
    expect(onGateway).toContain('aria-label="Actions for worker-b"');
    expect(onGateway).not.toContain("button-sm");
  });

  it("gives a narrow screen one muted line of figures per worker, and the wide table a meter and fraction for slots", () => {
    const markup = fleetHtml([DRAINED]);

    expect(fleetRow(DRAINED, "", NOW).summary).toBe(
      "slots 1/8 · CPU 28% · Mem 42% · Disk 77% · 1 lease",
    );
    expect(markup).toContain('class="fleet-list"');
    expect(markup).toContain('<span class="slots-fraction mono">1 / 8</span>');
    expect(markup).not.toContain("slot-leased");
  });

  it("shows the workers' events as a full-width log, or says there are none in the last hour", () => {
    const empty = text(fleetHtml([WORKER]));
    const shown = inConsole(
      <FleetBody page={fleet([WORKER])} log={{ data: { rows: [EVENT] }, kind: "ready" }} />,
    );

    expect(empty).toContain("Worker events live last hour · 0");
    expect(empty).toContain("No worker events in the last hour.");
    expect(text(shown)).toContain("last hour · 1");
    expect(text(shown)).toContain("12:00:00 worker.disconnected worker-a no heartbeat for 30 s");
    expect(shown).toContain('href="/activity/evt_1"');
    expect(shown).toContain("visual-log-error");
  });
});

describe("a worker's update on the Fleet screen", () => {
  it("reads its stage on the card, and the failed worker's page offers Update again", () => {
    const updating = { ...WORKER, update: { ...UPDATE, stage: "waiting" as const } };
    const failed = {
      ...WORKER,
      lastUpdateFailure: {
        at: NOW - 60_000,
        from: "1.4.0",
        message: "EACCES",
        stage: "installing" as const,
        to: "1.5.0",
      },
      latestVersion: "1.5.0",
    };
    const idle = html(page(WORKER));

    expect(fleetRow(updating, "", NOW).reason).toContain("waiting for 2 leases");
    expect(fleetRow(WORKER, "", NOW).reason).not.toContain("waiting for");
    const again = text(inConsole(<WorkerPageBody page={page(failed)} log={NO_EVENTS} />, GATEWAY));
    expect(again).toContain("Update to 1.5.0 failed (installing): EACCES Update again");
    expect(inConsole(<WorkerPageBody page={page(failed)} log={NO_EVENTS} />)).not.toContain(
      "page-note",
    );
    expect(text(idle)).not.toContain("Update again");
    expect(text(inConsole(<WorkerPageBody page={page(failed)} log={NO_EVENTS} />))).not.toContain(
      "Update again",
    );
  });
});

describe("a worker's page", () => {
  it("is titled Fleet / name, with the health word beside it and no subtitle", () => {
    const markup = html(page(WORKER));

    expect(markup).toContain('<a class="page-crumb" href="/fleet">Fleet</a>');
    expect(markup).toMatch(/<h1[^>]*>.*worker-a<\/h1>/);
    expect(text(markup)).toContain("Fleet / worker-a memory pressure warn");
    expect(markup).not.toContain("page-note");
    expect(text(markup)).not.toContain("read 12 s ago");
  });

  it("draws CPU, memory, disk and slots as rings, each with its figure and one line of context", () => {
    const shown = text(html(page(WORKER)));

    expect(shown).toContain("CPU 12 cores 28% busy");
    expect(shown).toContain("Memory 15.1 GiB used of 36.0 GiB · pressure warn");
    expect(shown).toContain("Disk 112.4 GiB free of 494.4 GiB");
    expect(shown).toContain("Slots 1 of 8 leased 7 free");
    expect(html(page(WORKER))).toContain("--load-bar:");
  });

  it("lists slots by platform, the host's facts with the worker id, and its baselines", () => {
    const markup = html(
      page({
        ...WORKER,
        baselines: [
          {
            mode: "full",
            model: "iPhone 17",
            name: "ios-26-clean",
            osVersion: "26.0",
            platform: "ios",
            savedAt: "2026-10-02T11:00:00Z",
            sizeBytes: 8.1 * GIB,
            version: 1,
          },
        ],
      }),
    );
    const shown = text(markup);

    expect(shown).toContain("Slots iOS 1 / 4 Android 0 / 4");
    expect(shown).toContain("Host macOS 15.5 simlock 1.4.0 Worker id wrk_1");
    expect(shown).toContain("Baselines here ios-26-clean 8.1 GiB");
  });

  it("draws a leased device as a row with its holder, time left, Watch link and granted time", () => {
    const markup = html(page(WORKER));
    const shown = text(markup);

    expect(markup).toContain('href="/fleet/wrk_1/devices/dev_1"');
    expect(markup).toContain(">Watch</a>");
    expect(shown).toContain("iPhone 17 iOS 26.0 leased");
    expect(shown).toContain("agent");
    expect(shown).toContain("01:00");
    expect(shown).toMatch(/granted \d\d:\d\d Watch/);
  });

  it("draws a ready device as a row that was booted, with no holder", () => {
    const view: WorkerView = {
      ...WORKER,
      devices: [{ ...WORKER.devices![0]!, state: "ready", transitionAgeMs: 120_000 }],
      leases: [],
    };
    const shown = text(html(page(view)));

    expect(shown).toContain("ready");
    expect(shown).toMatch(/booted \d\d:\d\d Watch/);
  });

  it("offers the Devices and Warm pool tabs only, with the events log on the page whichever is chosen", () => {
    const devices = html(page(WORKER));
    const warm = html(
      page(
        {
          ...WORKER,
          warmPool: { enabled: true, reserveRunning: { android: 0, ios: 0 }, targets: [] },
        },
        "warm-pool",
      ),
    );
    const withEvent = inConsole(
      <WorkerPageBody
        page={page(WORKER)}
        log={{
          data: {
            end: undefined,
            loadOlder: () => {},
            rows: [{ ...EVENT, name: "lease.granted" }],
          },
          kind: "ready",
        }}
      />,
    );

    expect(devices).not.toContain(">Events<");
    expect(devices).not.toContain('class="tab">Host<');
    expect(devices).toContain("Events on this worker");
    expect(warm).toContain("Events on this worker");
    expect(text(warm)).toContain("Pool On");
    expect(text(withEvent)).toContain("lease.granted");
  });

  it("says No devices. for a worker whose devices were never read", () => {
    const { devices: _devices, ...unread } = WORKER;

    expect(text(html(page(unread)))).toContain("No devices.");
  });

  it("says No reading while disconnected in place of the load rings of a disconnected worker", () => {
    const shown = text(html(page({ ...WORKER, connection: "disconnected" })));

    expect(shown).toContain("No reading while disconnected");
    expect(shown).not.toContain("busy");
  });

  it("shows a starting worker without devices, slots or a warm pool tab", () => {
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

  it("shows an incompatible worker's protocol ranges beside its host facts, and no devices or load", () => {
    const old: WorkerView = {
      connection: "incompatible",
      drained: false,
      id: "wrk_old",
      label: "old-worker",
      lastSeenAt: NOW,
      protocol: { gateway: { max: 35, min: 35 }, worker: { max: 30, min: 30 } },
    };

    const markup = html(page(old));
    const shown = text(markup);

    expect(shown).toContain("No devices: the gateway cannot read this worker.");
    expect(shown).not.toMatch(/read \d/);
    expect(markup).not.toContain("Load and leases");
    expect(shown).toContain("Protocol incompatible gateway 35–35, worker 30–30");
  });

  it("groups every capability under its own label, with the reason of an unavailable one", () => {
    const view: WorkerView = {
      ...WORKER,
      capabilities: [
        { name: "agent-device", state: "available" },
        { name: "stream", reason: "found 0.20.1, need 0.21.28 or later", state: "unavailable" },
      ],
      host: {
        arch: "arm64",
        os: "macOS",
        osVersion: "15.5",
        tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
      },
    };

    const markup = html(page(view));
    const shown = text(markup);

    expect(shown).toContain("xcode 16.4 (16F6)");
    expect(shown).toContain("Capabilities agent-device on stream unavailable found 0.20.1");
    expect(shown).toContain("Host macOS 15.5 xcode 16.4 (16F6) simlock 1.4.0 Worker id");
    expect(markup).toContain("pill-warn");
  });
});

describe("a worker's warm pool tab", () => {
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
