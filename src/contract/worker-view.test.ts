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
  it("builds a starting worker's view from its health and host alone, with every other field absent", () => {
    const view = workerViewFields({
      status: { daemon: { health: "starting", mode: "worker" }, host: HOST },
    });

    expect(view).toEqual({ health: "starting", host: HOST });
  });

  it("leaves a starting worker's view without the devices, catalog and config it would otherwise be given", () => {
    const view = workerViewFields({
      catalog: { platforms: [] },
      config: CONFIG,
      devices: [],
      status: { daemon: { health: "starting", mode: "worker" }, host: HOST },
    });

    expect(view).toEqual({ health: "starting", host: HOST });
  });

  it("copies every field a running worker reports, and makes an absent installs or waiting list empty", () => {
    const view = workerViewFields({
      devices: [],
      status: {
        capacity: CAPACITY,
        daemon: { health: "running", mode: "worker" },
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
      leases: [],
      queueDepth: 3,
      waiting: [],
    });
  });

  it("leaves a field out of a running worker's view when the worker's answer has none, rather than making it empty", () => {
    const view = workerViewFields({
      status: { daemon: { health: "running", mode: "worker" }, host: HOST },
    });

    expect(Object.keys(view).sort()).toEqual(["health", "host", "installs", "waiting"]);
  });
});
