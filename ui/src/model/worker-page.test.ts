import { describe, expect, it } from "vitest";

import { listSearch } from "./paging";
import {
  filterWorkers,
  readFilter,
  upMeta,
  type WorkerPage,
  workerPageOf,
  workerRow,
  writeFilter,
} from "./worker-page";
import type { WorkerDevice, WorkerView } from "./workers";

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

const CAPACITY = {
  android: { ...ENTRY, running: 0, used: 0 },
  global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 0 },
  ios: ENTRY,
};

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: CAPACITY,
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function device(overrides: Record<string, unknown> = {}): WorkerDevice {
  return {
    id: "dev_1",
    mode: "full",
    physical: false,
    servesDefaultMode: true,
    spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
    state: "ready",
    ...overrides,
  } as unknown as WorkerDevice;
}

const LEASE = {
  deviceId: "dev_1",
  grantedAt: NOW - 125_000,
  id: "l_1",
  idChosenByRequester: false,
  lastRenewedAt: NOW - 20_000,
  ownerId: "agent",
  requesterId: "tok_1",
  ttlDeadline: NOW + 60_000,
  ttlMs: 185_000,
};

const LOAD = {
  cpu: { busyPercent: 34, cores: 10, limited: false },
  disk: { freeBytes: 112.4 * GIB, totalBytes: 494.4 * GIB },
  memory: {
    availableBytes: 9.8 * GIB,
    limited: false,
    pressure: "normal" as const,
    swapUsedBytes: 1.2 * GIB,
    totalBytes: 32 * GIB,
  },
  readAt: NOW - 12_000,
};

function inspect(
  view: WorkerView,
  now = NOW,
  tokens: Parameters<typeof workerPageOf>[0]["tokens"] = [],
) {
  return workerPageOf({ now, tokens, worker: view });
}

function figure(inspector: WorkerPage, label: string) {
  return inspector.overview.figures.find((card) => card.label === label);
}

describe("a worker's row in the list", () => {
  it("carries the worker's name, its health square and its running figure over the sum of its platform limits", () => {
    const row = workerRow(worker({ label: "worker-a" }));

    expect(row).toMatchObject({
      health: { tone: "ok", word: "connected" },
      mono: false,
      name: "worker-a",
      to: "/fleet/wrk_1",
      use: { limit: 8, percent: 12.5, running: 1 },
    });
  });

  it("names a worker with no label by its id, in mono", () => {
    expect(workerRow(worker())).toMatchObject({ mono: true, name: "wrk_1" });
  });

  it("puts the worst finding in the square's word and nowhere else in the row", () => {
    const row = workerRow(worker({ drained: true }));

    expect(row.health).toEqual({ tone: "warn", word: "drained" });
    expect(JSON.stringify({ ...row, health: undefined })).not.toContain("drained");
  });

  it("has no use for a worker that is not connected or has reported no capacity", () => {
    expect(workerRow(worker({ connection: "disconnected" })).use).toBeUndefined();
    expect(workerRow(worker({ capacity: undefined })).use).toBeUndefined();
  });

  it("reads the filter from the address, All when it is absent or unknown, and a new one starts at the first page", () => {
    expect(readFilter("?filter=busy")).toBe("busy");
    expect(readFilter("?filter=nope")).toBe("all");
    expect(readFilter("")).toBe("all");
    expect(writeFilter("?page=3&q=ci", "issues")).toBe("?q=ci&filter=issues");
    expect(writeFilter("?filter=busy&page=3", "all")).toBe("");
  });

  it("keeps the list's page and size on the link, and nothing of a worker's own pagers", () => {
    expect(listSearch("?page=2&size=50&devices-page=3&warm-pool-size=50")).toBe("?page=2&size=50");
    expect(listSearch("?devices-page=3")).toBe("");
    expect(listSearch("?q=ci&page=2&size=50")).toBe("?page=2&size=50&q=ci");
    expect(listSearch("?page=2&filter=busy")).toBe("?page=2&filter=busy");
    expect(workerRow(worker(), "?page=2").to).toBe("/fleet/wrk_1?page=2");
  });
});

describe("the list's filters and header", () => {
  const busy = worker({
    id: "wrk_busy",
    capacity: {
      ...CAPACITY,
      android: { ...ENTRY, limit: 2, running: 2 },
      ios: { ...ENTRY, limit: 4, running: 4 },
    },
  });
  const quiet = worker({ id: "wrk_quiet" });
  const lost = worker({ connection: "disconnected", id: "wrk_lost" });
  const all = [quiet, busy, lost];

  it("All keeps every worker, Issues those whose health is not ok, Busy those with three quarters of their slots in use", () => {
    expect(filterWorkers(all, "all").map((entry) => entry.id)).toEqual([
      "wrk_quiet",
      "wrk_busy",
      "wrk_lost",
    ]);
    expect(filterWorkers(all, "issues").map((entry) => entry.id)).toEqual(["wrk_lost"]);
    expect(filterWorkers(all, "busy").map((entry) => entry.id)).toEqual(["wrk_busy"]);
  });

  it("counts a worker as busy at exactly 75% and not below it", () => {
    const at = (running: number) =>
      worker({
        capacity: {
          ...CAPACITY,
          android: { ...ENTRY, limit: 0, running: 0 },
          ios: { ...ENTRY, limit: 4, running },
        },
      });

    expect(filterWorkers([at(3)], "busy")).toHaveLength(1);
    expect(filterWorkers([at(2)], "busy")).toHaveLength(0);
  });

  it("reads how many workers are up of all", () => {
    expect(upMeta(all)).toBe("2 / 3 up");
    expect(upMeta([])).toBe("0 / 0 up");
  });
});

describe("a worker's load figures", () => {
  it("states CPU, memory, swap, pressure, disk and the reading's age in the old panel's words", () => {
    const inspector = inspect(worker({ load: LOAD }));

    expect(figure(inspector, "CPU")?.text).toBe("34% busy, 10 cores");
    expect(figure(inspector, "Memory")?.text).toBe("9.8 GiB of 32.0 GiB available");
    expect(figure(inspector, "Memory")?.details).toEqual([
      { label: "Swap", text: "1.2 GiB used" },
      { label: "Pressure", text: "normal", tone: "ok" },
    ]);
    expect(figure(inspector, "Disk")?.text).toBe("112.4 GiB of 494.4 GiB free");
    expect(inspector.overview.read).toBe("12 s ago");
  });

  it("fills each meter to the figure's own percent", () => {
    const inspector = inspect(worker({ load: LOAD }));

    expect(
      [figure(inspector, "CPU"), figure(inspector, "Memory"), figure(inspector, "Disk")].map(
        (card) => card?.percent,
      ),
    ).toEqual([34, 69, 77]);
  });

  it("writes (limit) after a limited CPU or memory figure", () => {
    const inspector = inspect(
      worker({
        load: {
          ...LOAD,
          cpu: { busyPercent: 61, cores: 2, limited: true },
          memory: { ...LOAD.memory, limited: true },
        },
      }),
    );

    expect(figure(inspector, "CPU")?.text).toBe("61% busy, 2 cores (limit)");
    expect(figure(inspector, "Memory")?.text).toBe("9.8 GiB of 32.0 GiB available (limit)");
  });

  it("colours the memory meter by the worker's pressure word, whatever the percent", () => {
    const memory = (pressure: "normal" | "warn" | "critical") =>
      figure(
        inspect(worker({ load: { ...LOAD, memory: { ...LOAD.memory, pressure } } })),
        "Memory",
      );

    expect(memory("normal")?.tone).toBe("ok");
    expect(memory("warn")?.tone).toBe("warn");
    expect(memory("critical")?.tone).toBe("error");
  });

  it("falls back to the console's threshold for memory the worker gives no pressure for", () => {
    const { pressure: _pressure, ...bare } = LOAD.memory;
    const memory = (availableBytes: number) =>
      figure(inspect(worker({ load: { ...LOAD, memory: { ...bare, availableBytes } } })), "Memory");

    expect(memory(0.96 * GIB)).toMatchObject({ percent: 97, tone: "error" });
    expect(memory(1.5 * GIB)).toMatchObject({ percent: 95, tone: "error" });
    expect(memory(30 * GIB)).toMatchObject({ percent: 6, tone: "neutral" });
    expect(memory(30 * GIB)?.details.map((detail) => detail.label)).toEqual(["Swap"]);
  });

  it("colours the CPU and disk meters by the console's own thresholds, one step under each edge included", () => {
    const cpu = (busyPercent: number) =>
      figure(inspect(worker({ load: { ...LOAD, cpu: { ...LOAD.cpu, busyPercent } } })), "CPU")
        ?.tone;
    const disk = (free: number) =>
      figure(
        inspect(
          worker({ load: { ...LOAD, disk: { freeBytes: free * GIB, totalBytes: 500 * GIB } } }),
        ),
        "Disk",
      )?.tone;

    expect([84, 85, 94, 95].map(cpu)).toEqual(["neutral", "warn", "warn", "error"]);
    expect([80, 75, 30, 25].map(disk)).toEqual(["neutral", "warn", "warn", "error"]);
  });

  it("says Unavailable, with no meter, for an absent CPU, memory or disk", () => {
    const { cpu: _cpu, ...noCpu } = LOAD;
    const { memory: _memory, ...noMemory } = LOAD;
    const { disk: _disk, ...noDisk } = LOAD;

    expect(figure(inspect(worker({ load: noCpu })), "CPU")).toMatchObject({ text: "Unavailable" });
    expect(figure(inspect(worker({ load: noCpu })), "CPU")?.percent).toBeUndefined();
    expect(figure(inspect(worker({ load: noMemory })), "Memory")?.text).toBe("Unavailable");
    expect(figure(inspect(worker({ load: noDisk })), "Disk")?.text).toBe("Unavailable");
  });

  it("prints a figure whose total is zero without a meter", () => {
    const inspector = inspect(
      worker({
        load: { ...LOAD, memory: { ...LOAD.memory, availableBytes: 12 * GIB, totalBytes: 0 } },
      }),
    );

    expect(figure(inspector, "Memory")?.text).toContain("available");
    expect(figure(inspector, "Memory")?.percent).toBeUndefined();
  });

  it("ages the reading as now minus readAt rounded up to a whole second", () => {
    const view = worker({ load: { ...LOAD, readAt: NOW - 4_100 } });

    expect(inspect(view).overview.read).toBe("5 s ago");
    expect(inspect(view, NOW + 10_000).overview.read).toBe("15 s ago");
    expect(inspect(worker({ load: { ...LOAD, readAt: NOW + 3_000 } })).overview.read).toBe(
      "0 s ago",
    );
  });

  it("says No reading while disconnected for a disconnected worker, Not reported for a connected one with no load, and nothing for an incompatible one", () => {
    expect(inspect(worker({ connection: "disconnected", load: LOAD })).overview).toMatchObject({
      figures: [],
      loadNote: "No reading while disconnected",
    });
    expect(inspect(worker()).overview).toMatchObject({ figures: [], loadNote: "Not reported" });
    const incompatible = inspect(worker({ connection: "incompatible", load: LOAD }));
    expect(incompatible.overview.figures).toEqual([]);
    expect(incompatible.overview.loadNote).toBeUndefined();
  });
});

describe("a worker's capacity and leases", () => {
  it("gives each platform its running and limit, and its slots by state with the room left as free", () => {
    const inspector = inspect(worker({ devices: [device()] }));

    expect(
      inspector.overview.platforms.map((platform) => [
        platform.name,
        platform.running,
        platform.limit,
      ]),
    ).toEqual([
      ["iOS", 1, 4],
      ["Android", 0, 4],
    ]);
    expect(inspector.overview.platforms[0]?.label).toBe("iOS: 1 ready, 3 free");
    expect(inspector.overview.platforms[0]?.slots).toHaveLength(4);
  });

  it("counts the leases it holds beside the devices running", () => {
    expect(inspect(worker({ leases: [LEASE] })).overview.leases).toEqual({ count: 1, running: 1 });
  });

  it("leaves capacity, leases and devices out for a worker that reports it is starting", () => {
    const starting: WorkerView = {
      connection: "connected",
      drained: false,
      health: "starting",
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
      id: "wrk_1",
      lastSeenAt: NOW,
    };

    const inspector = inspect(starting);

    expect(inspector.overview).toMatchObject({ platforms: [], starting: true });
    expect(inspector.overview.devices).toBeUndefined();
    expect(inspector.overview.leases).toBeUndefined();
    expect(inspector.warm).toBeUndefined();
    expect(inspector.tabs.map((tab) => tab.value)).toEqual(["devices", "host", "events"]);
    expect(inspector.host.capabilities).toBeUndefined();
    expect(inspector.health).toEqual({ tone: "warn", word: "starting" });
  });
});

describe("a worker's device rows", () => {
  it("shows an unknown state as its own word in the neutral tone", () => {
    const [row] =
      inspect(worker({ devices: [device({ state: "hibernating" })] })).overview.devices ?? [];

    expect(row?.status).toEqual({ tone: "idle", word: "hibernating" });
  });

  it("shows an absent device's state as absent in the warn tone", () => {
    const [row] =
      inspect(worker({ devices: [device({ state: "absent" })] })).overview.devices ?? [];

    expect(row?.status).toEqual({ tone: "warn", word: "absent" });
  });

  it("gives a leased device its holder, a link to the lease, the time on the lease and what is left of it", () => {
    const view = worker({ devices: [device({ state: "leased" })], leases: [LEASE] });

    const [row] =
      inspect(view, NOW, [{ id: "tok_1", label: "ci-agent" }] as never).overview.devices ?? [];

    expect(row).toMatchObject({
      expires: "1 min",
      holder: { id: "tok_1", name: "ci-agent", to: "/leases/l_1/" },
      renewed: "20 s ago",
      since: "2 min 5 s",
    });
  });

  it("links a holder to the lease's page under the id the daemon lists it by, a gateway's worker-qualified one included", () => {
    const view = worker({ devices: [device({ state: "leased" })], leases: [LEASE] });
    const holderOn = (leaseIds: readonly string[]) =>
      workerPageOf({ leaseIds, now: NOW, tokens: [], worker: view }).overview.devices?.[0]?.holder
        ?.to;

    expect(holderOn([`${view.id}.l_1`])).toBe(`/leases/${encodeURIComponent(`${view.id}.l_1`)}/`);
    expect(holderOn(["l_1"])).toBe("/leases/l_1/");
    expect(holderOn([])).toBe("/leases/l_1/");
  });

  it("names a holder by its id where no token has it", () => {
    const view = worker({ devices: [device({ state: "leased" })], leases: [LEASE] });

    expect(inspect(view).overview.devices?.[0]?.holder?.name).toBe("tok_1");
  });

  it("shows how long a device has been in a state the data dates, and a dash-able gap for one it does not", () => {
    const view = worker({
      devices: [
        device({ id: "dev_new", state: "provisioning", transitionAgeMs: 4_000 }),
        device({ id: "dev_ready" }),
      ],
      lastSeenAt: NOW - 10_000,
    });

    const rows = inspect(view).overview.devices ?? [];

    expect(rows.map((row) => [row.id, row.since])).toEqual([
      ["dev_new", "14 s"],
      ["dev_ready", undefined],
    ]);
  });

  it("shows no time for a device mid-provisioning on a disconnected worker", () => {
    const view = worker({
      connection: "disconnected",
      devices: [device({ state: "provisioning", transitionAgeMs: 4_000 })],
      lastSeenAt: NOW - 10_000,
    });

    expect(inspect(view).overview.devices?.[0]?.since).toBeUndefined();
  });

  it("marks a physical device Physical with no mode and no image tag, and a simulator Virtual", () => {
    const physical = device({
      class: "phone",
      id: "dev_p",
      mode: undefined,
      physical: true,
      driverDeviceId: "00008130-AAAA",
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
    });
    const rows =
      inspect(worker({ devices: [physical, device({ id: "dev_v", driverDeviceId: "SIM-1" })] }))
        .overview.devices ?? [];

    expect(rows.map((row) => [row.id, row.udid])).toEqual([
      ["dev_p", "00008130-AAAA"],
      ["dev_v", undefined],
    ]);

    expect(rows.map((row) => [row.id, row.physical, row.mode, row.imageTag])).toEqual([
      ["dev_p", true, undefined, undefined],
      ["dev_v", false, undefined, undefined],
    ]);
  });

  it("shows a mode only where the device is not served as the default, and an image tag where it has one", () => {
    const slim = device({ id: "dev_slim", mode: "slim", servesDefaultMode: false });
    const tagged = device({
      id: "dev_tag",
      spec: {
        imageTag: "google_apis",
        model: "Pixel 9",
        osVersion: "35",
        physical: false,
        platform: "android",
      },
    });

    const rows = inspect(worker({ devices: [slim, tagged] })).overview.devices ?? [];

    expect(rows.map((row) => [row.id, row.mode, row.imageTag, row.platform])).toEqual([
      ["dev_slim", "slim", undefined, "iOS"],
      ["dev_tag", undefined, "google_apis", "Android"],
    ]);
  });
});

describe("a worker's host tab", () => {
  it("names the machine, its tools with their build, its connection, drain and health", () => {
    const { host } = inspect(
      worker({
        drained: true,
        host: {
          arch: "arm64",
          os: "macOS",
          osVersion: "15.5",
          tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
        },
      }),
    );

    expect(host).toMatchObject({
      connection: { tone: "ok", word: "connected" },
      drained: true,
      health: { tone: "ok", word: "running" },
      host: {
        arch: "arm64",
        os: "macOS 15.5",
        tools: [{ name: "xcode", platform: "iOS", version: "16.4 (16F6)" }],
      },
      id: "wrk_1",
    });
  });

  it("calls a worker compatible, and names both protocol ranges for an incompatible one", () => {
    expect(inspect(worker()).host.protocol).toEqual({ compatible: true });
    const old = inspect({
      connection: "incompatible",
      drained: false,
      id: "wrk_1",
      lastSeenAt: NOW,
      protocol: { gateway: { max: 35, min: 35 }, worker: { max: 30, min: 30 } },
    });

    expect(old.host.protocol).toEqual({ compatible: false, ranges: "gateway 35–35, worker 30–30" });
    expect(old.overview.incompatible).toBe(true);
  });

  it("shows a capability's state in its tone with its reason, and Not reported for an absent list", () => {
    const { host } = inspect(
      worker({
        capabilities: [
          { name: "agent-device", state: "available" },
          { name: "second", state: "off" },
          { name: "third", reason: "found 0.20.1, need 0.21.28 or later", state: "unavailable" },
        ],
      }),
    );

    expect(host.capabilities).toEqual([
      { name: "agent-device", state: "available", tone: "ok" },
      { name: "second", state: "off", tone: "idle" },
      {
        name: "third",
        reason: "found 0.20.1, need 0.21.28 or later",
        state: "unavailable",
        tone: "warn",
      },
    ]);
    expect(inspect(worker()).host.capabilities).toBe("not-reported");
  });

  it("lists the catalog's models and runtimes per platform, marking the default runtime", () => {
    const { host } = inspect(
      worker({
        catalog: [
          {
            classDefaults: {},
            defaultRuntime: "26.0",
            modelAliases: {},
            modelClasses: {},
            modelRuntimes: {},
            models: ["iPhone 17"],
            platform: "ios",
            runtimes: ["18.4", "26.0"],
          },
          {
            classDefaults: {},
            modelAliases: {},
            modelClasses: {},
            modelRuntimes: {},
            models: [],
            platform: "android",
            runtimes: [],
          },
        ],
      }),
    );

    expect(host.catalog).toEqual([
      { models: "iPhone 17", platform: "iOS", runtimes: "18.4, 26.0 (default)" },
      { models: "none", platform: "Android", runtimes: "none" },
    ]);
    expect(inspect(worker({ catalog: undefined })).host.catalog).toEqual([]);
  });
});

describe("a worker's warm pool tab", () => {
  const target = {
    booting: 0,
    count: 1,
    mode: "full" as const,
    model: "iPhone 17",
    osVersion: "27.0",
    platform: "ios" as const,
    ready: 0,
    short: "runtime-missing" as const,
  };

  it("lists each kind the pool keeps with its wanted, ready and booting numbers and the reason it is short, a dash where there is none", () => {
    const { warm } = inspect(
      worker({
        warmPool: {
          enabled: true,
          reserveRunning: { android: 0, ios: 1 },
          targets: [
            { ...target, booting: 1, count: 2, osVersion: "26.0", ready: 1, short: undefined },
            { ...target, osVersion: undefined },
          ],
        },
      }),
    );

    expect(warm?.pool).toEqual({ enabled: "On", reserve: "iOS 1, Android 0" });
    expect(
      warm?.targets.map((row) => [
        row.model,
        row.runtime,
        row.wanted,
        row.ready,
        row.booting,
        row.short,
      ]),
    ).toEqual([
      ["iPhone 17", "26.0", 2, 1, 1, "—"],
      ["iPhone 17", "—", 1, 0, 0, "runtime-missing"],
    ]);
  });

  it("says the pool is off when the worker reports it so, and keeps two refused targets of one kind as two rows", () => {
    const { warm } = inspect(
      worker({
        warmPool: {
          enabled: false,
          reserveRunning: { android: 0, ios: 0 },
          targets: [target, target],
        },
      }),
    );

    expect(warm?.pool?.enabled).toBe("Off");
    expect(new Set(warm?.targets.map((row) => row.key)).size).toBe(2);
  });

  it("has no pool for a worker that has not reported one", () => {
    expect(inspect(worker()).warm?.pool).toBeUndefined();
  });

  it("lists the installs in progress with their state, how long and how many wait", () => {
    const { warm } = inspect(
      worker({
        installs: [
          {
            component: "19.0",
            platform: "ios",
            since: NOW - 7_000,
            state: "downloading",
            waiters: 1,
          },
          {
            component: "36",
            platform: "android",
            since: NOW - 3_000,
            state: "waiting",
            waiters: 3,
          },
        ],
      }),
    );

    expect(
      warm?.installs.map((install) => [
        install.platform,
        install.component,
        install.status,
        install.duration,
        install.waiters,
      ]),
    ).toEqual([
      ["iOS", "19.0", { tone: "ok", word: "downloading" }, "7 s", "1 waiter"],
      ["Android", "36", { tone: "idle", word: "waiting" }, "3 s", "3 waiters"],
    ]);
  });
});

describe("a worker page's tab", () => {
  const tabOf = (search: string, view: WorkerView = worker()) =>
    workerPageOf({ now: NOW, search, tokens: [], worker: view }).tab;

  it("is the one ?tab= names, and Devices for a value the page does not offer", () => {
    expect(tabOf("?tab=host")).toBe("host");
    expect(tabOf("?tab=events&page=2")).toBe("events");
    expect(tabOf("")).toBe("devices");
    expect(tabOf("?tab=overview")).toBe("devices");
    expect(tabOf("?tab=")).toBe("devices");
  });

  it("is Devices when ?tab= names the warm pool of a starting worker, which has none", () => {
    const starting = worker({ health: "starting" });

    expect(tabOf("?tab=warm-pool")).toBe("warm-pool");
    expect(tabOf("?tab=warm-pool", starting)).toBe("devices");
    expect(tabOf("?tab=host", starting)).toBe("host");
  });
});
