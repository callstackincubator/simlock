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
      physical: false,
      id: "dev_1",
      mode: "full",
      servesDefaultMode: true,
      spec: { physical: false, model: "iPhone 17", osVersion: "26.0", platform: "ios" },
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
      idChosenByRequester: false,
      ttlMs: 60_000,
    },
  ],
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
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

  it("marks a simulator Virtual and an enrolled device Physical, and shows a dash for the physical device's mode and image tag and for a simulator with no image tag", () => {
    const shown = detail({
      ...RUNNING,
      devices: [
        {
          physical: false,
          id: "dev_sim",
          mode: "full",
          servesDefaultMode: true,
          spec: {
            imageTag: "google_apis",
            model: "Pixel 9",
            osVersion: "35",
            physical: false,
            platform: "android",
          },
          state: "ready",
        },
        {
          physical: false,
          id: "dev_ios",
          mode: "full",
          servesDefaultMode: true,
          spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
          state: "ready",
        },
        {
          class: "phone",
          driverDeviceId: "00008110-001A2B3C4D5E",
          id: "dev_phys",
          physical: true,
          servesDefaultMode: true,
          spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "ready",
        },
      ],
    });

    expect(shown).toContain("Android Virtual Pixel 9 35 full google_apis");
    expect(shown).toContain("iOS Virtual iPhone 16 26.5 full —");
    expect(shown).toContain("iOS Physical iPhone 15 Pro 18.4 — —");
  });

  it("a worker's page shows an absent device's state as the word absent in the warn tone", () => {
    const device = (id: string, state: string) =>
      ({
        class: "phone",
        driverDeviceId: "00008110-001A2B3C4D5E",
        id,
        physical: true,
        servesDefaultMode: true,
        spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
        state,
        ...(state === "absent" ? { absentReason: "locked" } : {}),
      }) as unknown as NonNullable<WorkerView["devices"]>[number];

    const html = renderToStaticMarkup(
      <WorkerDetail
        id="wrk_1"
        workers={[
          { ...RUNNING, devices: [device("dev_up", "ready"), device("dev_gone", "absent")] },
        ]}
        now={NOW}
      />,
    );

    const status = (tone: string, word: string) =>
      `<span class="status status-${tone}"><span class="status-dot" aria-hidden="true"></span>${word}</span>`;
    expect(html).toContain(status("ok", "ready"));
    expect(html).toContain(status("warn", "absent"));
    expect(text(html)).toContain("dev_gone absent");
  });

  it("says so where a worker's catalog and devices were never read", () => {
    const { catalog: _catalog, devices: _devices, ...unread } = RUNNING;

    const shown = detail(unread);

    expect(shown).toContain("Nothing reported.");
    expect(shown).toContain("No devices.");
  });
});

describe("the warm pool section of a worker's page", () => {
  const WARM_POOL = {
    enabled: true,
    reserveRunning: { android: 0, ios: 1 },
    targets: [
      {
        booting: 1,
        count: 2,
        mode: "full" as const,
        model: "iPhone 17",
        osVersion: "26.0",
        platform: "ios" as const,
        ready: 1,
      },
      {
        booting: 0,
        count: 1,
        mode: "full" as const,
        model: "iPhone 17",
        osVersion: "27.0",
        platform: "ios" as const,
        ready: 0,
        short: "runtime-missing" as const,
      },
    ],
  };

  it("lists each kind the pool keeps with its wanted, ready and booting numbers and the reason it is short", () => {
    const shown = detail({ ...RUNNING, warmPool: WARM_POOL });

    expect(shown).toContain("Warm pool");
    expect(shown).toContain("iPhone 17 26.0 full 2 1 1 —");
    expect(shown).toContain("iPhone 17 27.0 full 1 0 0 runtime-missing");
  });

  it("heads the table with its seven columns, right-aligns the numbers and sets the runtime and the reason in mono", () => {
    const html = renderToStaticMarkup(
      <WorkerDetail id="wrk_1" workers={[{ ...RUNNING, warmPool: WARM_POOL }]} now={NOW} />,
    );

    // The devices table carries a Model and a Mode column too, so each is there twice.
    const occurrences = (text: string): number => html.split(text).length - 1;
    for (const header of ["Model", "Mode"]) {
      expect(occurrences(`<th scope="col">${header}</th>`)).toBe(2);
    }
    for (const header of ["Runtime", "Short"]) {
      expect(html).toContain(`<th scope="col">${header}</th>`);
    }
    for (const header of ["Wanted", "Ready", "Booting"]) {
      expect(html).toContain(`<th scope="col" class="num">${header}</th>`);
    }
    expect(html).toContain('<td data-label="Runtime" class="mono">27.0</td>');
    expect(html).toContain('<td data-label="Short" class="mono">runtime-missing</td>');
    expect(html).toContain('<td data-label="Wanted" class="num">2</td>');
    expect(html).toContain('<td data-label="Model">iPhone 17</td>');
  });

  it("shows a runtime-less target's runtime as a dash, says the pool is on, and says when there are no targets", () => {
    const unversioned = {
      booting: 0,
      count: 1,
      mode: "full" as const,
      model: "iPhone 17",
      platform: "ios" as const,
      ready: 0,
      short: "runtime-missing" as const,
    };
    const shown = detail({ ...RUNNING, warmPool: { ...WARM_POOL, targets: [unversioned] } });
    const empty = detail({ ...RUNNING, warmPool: { ...WARM_POOL, targets: [] } });

    expect(shown).toContain("iPhone 17 — full 1 0 0 runtime-missing");
    expect(shown).toContain("Pool On");
    expect(empty).toContain("No targets.");
  });

  it("shows two refused targets of one kind as two rows", () => {
    const refused = WARM_POOL.targets[1]!;

    const shown = detail({ ...RUNNING, warmPool: { ...WARM_POOL, targets: [refused, refused] } });

    expect(shown.split("iPhone 17 27.0 full 1 0 0 runtime-missing")).toHaveLength(3);
  });

  it("says the pool is off when the worker reports it so, and shows the reserve", () => {
    const shown = detail({ ...RUNNING, warmPool: { ...WARM_POOL, enabled: false } });

    expect(shown).toContain("Pool Off");
    expect(shown).toContain("Reserved running slots iOS 1, Android 0");
  });

  it("the warm pool's Not reported test checks the Warm pool panel alone", () => {
    const shown = detail(RUNNING);
    const start = shown.indexOf("The devices the worker keeps booted ahead of demand");
    const panel = shown.slice(start, shown.indexOf("Installs in progress", start));

    expect(start).toBeGreaterThan(-1);
    expect(panel).toContain("Not reported.");
  });

  it("shows none for a worker that is still starting", () => {
    const shown = detail({
      health: "starting",
      connection: "connected",
      drained: false,
      id: "wrk_1",
      lastSeenAt: NOW,
    });

    expect(shown).not.toContain("Warm pool");
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

describe("the Capabilities row of a worker's page", () => {
  const status = (tone: string, word: string) =>
    `<span class="status status-${tone}"><span class="status-dot" aria-hidden="true"></span>${word}</span>`;
  const page = (worker: WorkerView) =>
    renderToStaticMarkup(<WorkerDetail id="wrk_1" workers={[worker]} now={NOW} />);

  it("shows available in the ok tone, off in the neutral tone, and unavailable in the warn tone with its reason", () => {
    const html = page({
      ...RUNNING,
      capabilities: [
        { name: "agent-device", state: "available" },
        { name: "second", state: "off" },
        { name: "third", reason: "found 0.20.1, need 0.21.25 or later", state: "unavailable" },
      ],
    });

    expect(text(html)).toContain("Capabilities");
    expect(html).toContain(status("ok", "available"));
    expect(html).toContain(status("idle", "off"));
    expect(html).toContain(status("warn", "unavailable"));
    expect(text(html)).toContain("third unavailable found 0.20.1, need 0.21.25 or later");
  });

  it("says Not reported for an absent list on a running worker", () => {
    expect(text(page(RUNNING))).toContain("Capabilities Not reported");
  });

  it("leaves the row out for a starting worker", () => {
    const starting = text(
      page({
        connection: "connected",
        drained: false,
        health: "starting",
        id: "wrk_1",
        lastSeenAt: NOW,
      }),
    );

    expect(text(page(RUNNING))).toContain("Capabilities");
    expect(starting).not.toContain("Capabilities");
  });

  it("shows the same row on the worker's card", () => {
    const card = text(
      renderToStaticMarkup(
        <WorkerFacts
          worker={{ ...RUNNING, capabilities: [{ name: "agent-device", state: "available" }] }}
        />,
      ),
    );

    expect(card).toContain("Capabilities agent-device available");
  });
});

const GIB = 1024 ** 3;

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

const STARTING: WorkerView = {
  connection: "connected",
  drained: false,
  health: "starting",
  host: RUNNING.host,
  id: "wrk_1",
  lastSeenAt: NOW,
};

const LOAD_DESCRIPTION = "How busy the machine is right now";

function detailAt(worker: WorkerView, now: number): string {
  return text(renderToStaticMarkup(<WorkerDetail id="wrk_1" workers={[worker]} now={now} />));
}

function loadPanel(shown: string): string {
  const start = shown.indexOf(LOAD_DESCRIPTION);
  if (start === -1) return "";
  const ends = ["Warm pool", "Devices, leases and capacity appear"]
    .map((marker) => shown.indexOf(marker, start))
    .filter((index) => index !== -1);
  return shown.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

describe("a worker's card shows its load", () => {
  const card = (worker: WorkerView) => text(renderToStaticMarkup(<WorkerFacts worker={worker} />));

  it("a running worker's card shows the Load row right after Capabilities, and a starting worker's right after Version", () => {
    const running = card({ ...RUNNING, load: LOAD });
    expect(running).toContain("Load CPU 34% · memory 9.8 of 32.0 GiB · disk 112.4 GiB free");
    expect(running.indexOf("Capabilities")).toBeGreaterThan(running.indexOf("Capacity"));
    expect(running.indexOf("Load")).toBeGreaterThan(running.indexOf("Capabilities"));

    const starting = card({ ...STARTING, load: LOAD, version: "1.2.3" });
    expect(starting).toContain("Version 1.2.3 Load CPU 34% · memory 9.8 of 32.0 GiB");
    expect(starting).not.toContain("Devices");
  });

  it("a worker card says Not reported for a connected worker with no load, and No reading while disconnected for a disconnected one", () => {
    expect(card(RUNNING)).toContain("Load Not reported");
    expect(card({ ...RUNNING, connection: "disconnected", load: LOAD })).toContain(
      "Load No reading while disconnected",
    );
  });

  it("an incompatible worker's card and page have no Load row or panel", () => {
    const incompatible: WorkerView = {
      connection: "incompatible",
      drained: false,
      id: "wrk_1",
      lastSeenAt: NOW,
      load: LOAD,
      protocol: { gateway: { max: 35, min: 35 }, worker: { max: 30, min: 30 } },
    };

    expect(card(incompatible)).not.toContain("Load");
    const page = detailAt(incompatible, NOW);
    expect(page).not.toContain("Load ");
    expect(page).not.toContain(LOAD_DESCRIPTION);
  });
});

describe("a worker's page shows its load", () => {
  it("a running worker's detail shows the Load panel after Host and Catalog, with CPU, memory, swap, pressure, disk and the reading's age", () => {
    const shown = detailAt({ ...RUNNING, load: LOAD }, NOW);

    expect(shown.indexOf(LOAD_DESCRIPTION)).toBeGreaterThan(
      shown.indexOf("The models and runtimes it can lease."),
    );
    expect(shown.indexOf("The models and runtimes it can lease.")).toBeGreaterThan(
      shown.indexOf("The machine the worker runs on."),
    );
    const panel = loadPanel(shown);
    expect(panel).toContain("CPU 34% busy, 10 cores");
    expect(panel).toContain("Memory 9.8 GiB of 32.0 GiB available");
    expect(panel).toContain("Swap 1.2 GiB used");
    expect(panel).toContain("Pressure normal");
    expect(panel).toContain("Disk 112.4 GiB of 494.4 GiB free");
    expect(panel).toContain("Read 12 s ago");
  });

  it("a starting worker's detail shows the Load panel after Host and before the startup line", () => {
    const shown = detailAt({ ...STARTING, load: LOAD }, NOW);
    const at = shown.indexOf(LOAD_DESCRIPTION);

    expect(at).toBeGreaterThan(shown.indexOf("The machine the worker runs on."));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(shown.indexOf("Devices, leases and capacity appear once startup"));
  });

  it("a worker's detail leaves out Pressure when the view has none, and leaves out Swap and Pressure when memory is absent", () => {
    const { pressure: _pressure, ...noPressure } = LOAD.memory;
    const withoutPressure = loadPanel(
      detailAt({ ...RUNNING, load: { ...LOAD, memory: noPressure } }, NOW),
    );
    expect(withoutPressure).toContain("Swap 1.2 GiB used");
    expect(withoutPressure).not.toContain("Pressure");

    const { memory: _memory, ...noMemory } = LOAD;
    const withoutMemory = loadPanel(detailAt({ ...RUNNING, load: noMemory }, NOW));
    expect(withoutMemory).toContain("CPU 34% busy");
    expect(withoutMemory).not.toContain("Swap");
    expect(withoutMemory).not.toContain("Pressure");
  });

  it("a worker's detail shows pressure normal, warn and critical in the ok, warn and error tones", () => {
    const tone = (pressure: "normal" | "warn" | "critical") =>
      renderToStaticMarkup(
        <WorkerDetail
          id="wrk_1"
          workers={[{ ...RUNNING, load: { ...LOAD, memory: { ...LOAD.memory, pressure } } }]}
          now={NOW}
        />,
      );
    const status = (kind: string, word: string) =>
      `<span class="status status-${kind}"><span class="status-dot" aria-hidden="true"></span>${word}</span>`;

    expect(tone("normal")).toContain(status("ok", "normal"));
    expect(tone("warn")).toContain(status("warn", "warn"));
    expect(tone("critical")).toContain(status("error", "critical"));
  });

  it("a worker's detail says Unavailable in the row of an absent CPU, memory or disk", () => {
    const { cpu: _cpu, ...noCpu } = LOAD;
    const { memory: _memory, ...noMemory } = LOAD;
    const { disk: _disk, ...noDisk } = LOAD;

    expect(loadPanel(detailAt({ ...RUNNING, load: noCpu }, NOW))).toContain("CPU Unavailable");
    expect(loadPanel(detailAt({ ...RUNNING, load: noMemory }, NOW))).toContain(
      "Memory Unavailable",
    );
    expect(loadPanel(detailAt({ ...RUNNING, load: noDisk }, NOW))).toContain("Disk Unavailable");
  });

  it("a worker's detail says Not reported. in the Load panel with no load, and No reading while disconnected. for a disconnected worker", () => {
    expect(loadPanel(detailAt(RUNNING, NOW))).toContain("Not reported.");
    expect(
      loadPanel(detailAt({ ...RUNNING, connection: "disconnected", load: LOAD }, NOW)),
    ).toContain("No reading while disconnected.");
  });

  it("a worker's detail ages the reading as now minus readAt rounded up to a whole second, and shows a larger age for a later now", () => {
    const worker = { ...RUNNING, load: { ...LOAD, readAt: NOW - 4_100 } };

    expect(loadPanel(detailAt(worker, NOW))).toContain("Read 5 s ago");
    expect(loadPanel(detailAt(worker, NOW + 10_000))).toContain("Read 15 s ago");
    expect(
      loadPanel(detailAt({ ...worker, load: { ...LOAD, readAt: NOW + 3_000 } }, NOW)),
    ).toContain("Read 0 s ago");
  });

  it("the Status panel's description reads the worker's connection, health, capacity and load, and the Load panel's How busy the machine is right now", () => {
    const shown = detailAt({ ...RUNNING, load: LOAD }, NOW);

    expect(shown).toContain("The worker's connection, health, capacity and load.");
    expect(shown).toContain("How busy the machine is right now");
  });

  it("a worker's detail writes (limit) as muted text after a limited CPU or memory figure", () => {
    const html = renderToStaticMarkup(
      <WorkerDetail
        id="wrk_1"
        workers={[
          {
            ...RUNNING,
            load: {
              ...LOAD,
              cpu: { busyPercent: 61, cores: 2, limited: true },
              memory: { ...LOAD.memory, limited: true },
            },
          },
        ]}
        now={NOW}
      />,
    );
    const panel = loadPanel(text(html));

    expect(panel).toContain("CPU 61% busy, 2 cores (limit)");
    expect(panel).toContain("Memory 9.8 GiB of 32.0 GiB available (limit)");
    expect(html.match(/<span class="muted">\(limit\)<\/span>/g)).toHaveLength(2);
  });
});
