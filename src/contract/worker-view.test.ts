import { describe, expect, it } from "vitest";

import { workerViewFields } from "./worker-view.js";

const HOST = { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] };
const CAPACITY = {
  android: {
    atRamBudget: false,
    limit: 2,
    maxRunning: 2,
    overLimit: false,
    reserved: 0,
    running: 0,
    used: 0,
    warm: 0,
  },
  global: { maxRunning: 4, overLimit: false, reserved: 0, running: 0, warm: 0 },
  ios: {
    atRamBudget: false,
    limit: 2,
    maxRunning: 2,
    overLimit: false,
    reserved: 0,
    running: 0,
    used: 0,
    warm: 0,
  },
};

// Only the two sections a view reads; the rest of a daemon's config is not what is under test.
const CONFIG = {
  downloads: { policy: "always", timeoutMs: 60_000 },
  lease: { maxTtlMs: 900_000 },
} as unknown as NonNullable<Parameters<typeof workerViewFields>[0]["config"]>;

describe("workerViewFields", () => {
  it("keeps physical and class on a running worker's physical device, and refuses a device that breaks the type rule", () => {
    const device = {
      class: "phone",
      id: "dev_p",
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state: "ready",
    };
    const reads = (devices: unknown[]) =>
      ({
        devices,
        receivedAt: 0,
        status: {
          capacity: CAPACITY,
          daemon: {
            health: "running",
            mode: "worker",
            version: "0.0.0-test",
            update: null,
            lastUpdateFailure: null,
            latestVersion: null,
          },
          host: HOST,
          leases: [],
          queueDepth: 0,
        },
      }) as unknown as Parameters<typeof workerViewFields>[0];

    expect(workerViewFields(reads([device])).devices).toEqual([device]);
    expect(() => workerViewFields(reads([{ ...device, mode: "full" }]))).toThrow();
    expect(() => workerViewFields(reads([{ ...device, class: undefined }]))).toThrow();
    expect(() => workerViewFields(reads([{ ...device, physical: undefined }]))).toThrow();
  });

  it("a worker view keeps a device's quarantineCause", () => {
    const quarantineCause = { kind: "purge-failed", message: "Error: purge exploded" };
    const device = {
      id: "dev_q",
      mode: "full",
      physical: false,
      quarantineCause,
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "26.5", physical: false, platform: "ios" },
      state: "quarantined",
    };
    const reads = {
      devices: [device],
      receivedAt: 0,
      status: {
        capacity: CAPACITY,
        daemon: {
          health: "running",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
        leases: [],
        queueDepth: 0,
      },
    } as unknown as Parameters<typeof workerViewFields>[0];

    expect(workerViewFields(reads).devices).toEqual([device]);
  });

  it("the status device entry and the worker view accept state absent and each absentReason, and refuse another reason", () => {
    const absent = {
      class: "phone",
      id: "dev_7",
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state: "absent",
    };
    const reads = (device: object) =>
      ({
        devices: [device],
        receivedAt: 0,
        status: {
          capacity: CAPACITY,
          daemon: {
            health: "running",
            mode: "worker",
            version: "0.0.0-test",
            update: null,
            lastUpdateFailure: null,
            latestVersion: null,
          },
          host: HOST,
          leases: [],
          queueDepth: 0,
        },
      }) as unknown as Parameters<typeof workerViewFields>[0];

    for (const absentReason of ["locked", "untrusted", "not-present"] as const) {
      const device = { ...absent, absentReason };
      expect(() => workerViewFields(reads(device)), `absent (${absentReason})`).not.toThrow();
      expect(workerViewFields(reads(device)).devices).toEqual([device]);
    }
    expect(() => workerViewFields(reads({ ...absent, absentReason: "unplugged" }))).toThrow();
  });

  it("keeps a physical device's latest presence in the worker view built from list.get, and refuses a reason it does not know", () => {
    const record = {
      address: "00008110-001A2B3C4D5E",
      class: "phone",
      createdAt: 1,
      driverData: {},
      driverDeviceId: "00008110-001A2B3C4D5E",
      id: "dev_p",
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state: "ready",
    };
    const reads = (device: object) =>
      ({
        devices: [device],
        receivedAt: 0,
        status: {
          capacity: CAPACITY,
          daemon: {
            health: "running",
            mode: "worker",
            version: "0.0.0-test",
            update: null,
            lastUpdateFailure: null,
            latestVersion: null,
          },
          host: HOST,
          leases: [],
          queueDepth: 0,
        },
      }) as unknown as Parameters<typeof workerViewFields>[0];

    for (const presence of [
      { present: true },
      { present: false, reason: "locked" },
      { present: false, reason: "untrusted" },
      { present: false, reason: "not-present" },
    ]) {
      expect(workerViewFields(reads({ ...record, presence })).devices?.[0]).toMatchObject({
        presence,
      });
    }
    expect(workerViewFields(reads(record)).devices?.[0]).not.toHaveProperty("presence");
    expect(() =>
      workerViewFields(reads({ ...record, presence: { present: false, reason: "unplugged" } })),
    ).toThrow();
  });

  it("builds a starting worker's view from its health and host alone, with every other field absent", () => {
    const view = workerViewFields({
      receivedAt: 0,
      status: {
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
      },
    });

    expect(view).toEqual({ health: "starting", host: HOST });
  });

  it("leaves a starting worker's view without the devices, catalog and config it would otherwise be given", () => {
    const view = workerViewFields({
      receivedAt: 0,
      catalog: { platforms: [] },
      config: CONFIG,
      devices: [],
      status: {
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
      },
    });

    expect(view).toEqual({ health: "starting", host: HOST });
  });

  it("copies a running worker's warm pool block into its view, and leaves it out of a starting worker's", () => {
    const warmPool = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [],
    };

    const running = workerViewFields({
      receivedAt: 0,
      devices: [],
      status: {
        capacity: CAPACITY,
        daemon: {
          health: "running",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        devices: [],
        host: HOST,
        leases: [],
        queueDepth: 0,
        warmPool,
      },
    });
    const starting = workerViewFields({
      receivedAt: 0,
      status: {
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
        warmPool,
      },
    });

    expect(running.warmPool).toEqual(warmPool);
    expect(starting).not.toHaveProperty("warmPool");
  });

  it("copies every field a running worker reports, and makes an absent installs or waiting list empty", () => {
    const view = workerViewFields({
      receivedAt: 0,
      devices: [],
      status: {
        capacity: CAPACITY,
        daemon: {
          health: "running",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        devices: [],
        host: HOST,
        leases: [],
        queueDepth: 3,
      },
    });

    expect(view).toEqual({
      capacity: CAPACITY,
      devices: [],
      health: "running",
      host: HOST,
      installs: [],
      lastUpdateFailure: null,
      latestVersion: null,
      leases: [],
      queueDepth: 3,
      update: null,
      waiting: [],
    });
  });

  it("copies the physical line's depth beside the virtual one", () => {
    const status = {
      capacity: CAPACITY,
      daemon: {
        health: "running",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host: HOST,
      leases: [],
      physicalQueueDepth: 1,
      queueDepth: 2,
    } as unknown as Parameters<typeof workerViewFields>[0]["status"];

    const view = workerViewFields({ devices: [], receivedAt: 0, status });

    expect(view.queueDepth).toBe(2);
    expect(view).toHaveProperty("physicalQueueDepth", 1);
  });

  it("leaves a field out of a running worker's view when the worker's answer has none, rather than making it empty", () => {
    const view = workerViewFields({
      receivedAt: 0,
      status: {
        daemon: {
          health: "running",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
      },
    });

    expect(Object.keys(view).sort()).toEqual([
      "health",
      "host",
      "installs",
      "lastUpdateFailure",
      "latestVersion",
      "update",
      "waiting",
    ]);
  });
  describe("a worker's load", () => {
    const LOAD = {
      ageMs: 4_000,
      cpu: { busyPercent: 34.2, cores: 10, limited: false },
      disk: { freeBytes: 120, totalBytes: 500 },
      memory: {
        availableBytes: 4_000,
        limited: false,
        pressure: "normal" as const,
        swapUsedBytes: 100,
        totalBytes: 16_000,
      },
    };
    const { ageMs: _ageMs, ...PARTS } = LOAD;
    const running = (load?: typeof LOAD) =>
      ({
        capacity: CAPACITY,
        daemon: {
          health: "running",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        devices: [],
        host: HOST,
        leases: [],
        queueDepth: 0,
        ...(load === undefined ? {} : { load }),
      }) as unknown as Parameters<typeof workerViewFields>[0]["status"];

    it("workerViewFields turns a status load's ageMs into readAt on the given receive time, keeping every part, and floors readAt at 0", () => {
      const view = workerViewFields({ receivedAt: 10_000, status: running(LOAD) });

      expect(view.load).toEqual({ readAt: 6_000, ...PARTS });
      expect(workerViewFields({ receivedAt: 4_000, status: running(LOAD) }).load).toMatchObject({
        readAt: 0,
      });
      expect(workerViewFields({ receivedAt: 1_000, status: running(LOAD) }).load).toMatchObject({
        readAt: 0,
      });
    });

    it("workerViewFields copies load from a starting worker's status", () => {
      const status = {
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
        load: LOAD,
      } as unknown as Parameters<typeof workerViewFields>[0]["status"];

      const view = workerViewFields({ receivedAt: 10_000, status });

      expect(view).toEqual({
        health: "starting",
        host: HOST,
        load: { readAt: 6_000, ...PARTS },
      });
    });

    it("workerViewFields leaves load out when the status has none", () => {
      const starting = {
        daemon: {
          health: "starting",
          mode: "worker",
          version: "0.0.0-test",
          update: null,
          lastUpdateFailure: null,
          latestVersion: null,
        },
        host: HOST,
      } as unknown as Parameters<typeof workerViewFields>[0]["status"];

      expect(workerViewFields({ receivedAt: 10_000, status: running(LOAD) })).toHaveProperty(
        "load",
      );
      expect(workerViewFields({ receivedAt: 10_000, status: running() })).not.toHaveProperty(
        "load",
      );
      expect(workerViewFields({ receivedAt: 10_000, status: starting })).not.toHaveProperty("load");
    });
  });
});
