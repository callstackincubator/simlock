import { describe, expect, it } from "vitest";

import type { Platform } from "../../contract/index.js";
import {
  composeRoutingPolicy,
  createRoutingPolicy,
  eligible,
  type FilterStage,
  freeCapacity,
  type RoutableRequest,
  type RoutingDecision,
  warmHit,
} from "../routing.js";
import { catalogFixture, deviceFixture, statusFixture } from "../test-support.js";
import type { WorkerView } from "../worker-registry.js";

/**
 * The `warm-then-free` policy exactly as it was written on `main` before routing became a list
 * of stages (03c027f, `src/gateway/routing.ts`), kept here as the oracle the composed stages are
 * checked against. Do not edit it to match the stages: it is the behaviour they must reproduce.
 */
function legacyWarmThenFree(
  request: RoutableRequest,
  workers: readonly WorkerView[],
): Omit<RoutingDecision, "stage"> | undefined {
  // fallow-ignore-next-line complexity -- the oracle is a verbatim copy; simplifying it defeats its purpose.
  const isEligible = (worker: WorkerView): boolean => {
    if (worker.connection !== "connected") return false;
    if (worker.drained) return false;
    if (worker.capacity === undefined) return false;
    const catalog = worker.catalog.find((entry) => entry.platform === request.platform);
    if (catalog === undefined) return false;
    const hasModel = catalog.models.includes(request.model);
    const hasRuntime =
      request.osVersion === undefined || catalog.runtimes.includes(request.osVersion);
    if (hasModel && hasRuntime) return true;
    return request.allowDownload && (worker.downloads?.policy ?? "never") !== "never";
  };
  const hasWarmDevice = (worker: WorkerView): boolean =>
    worker.devices.some(
      (device) =>
        device.state === "ready" &&
        device.spec.platform === request.platform &&
        device.spec.model === request.model &&
        (request.osVersion === undefined || device.spec.osVersion === request.osVersion),
    );
  const free = (worker: WorkerView, platform: Platform): number => {
    const entry = worker.capacity?.[platform];
    if (entry === undefined) return 0;
    return Math.max(0, entry.maxRunning - entry.running - entry.reserved);
  };

  const eligibleWorkers = workers.filter(isEligible);
  const warm = eligibleWorkers.find(hasWarmDevice);
  if (warm !== undefined) return { reason: "warm-hit", workerId: warm.id };
  let best: { readonly workerId: string; readonly free: number } | undefined;
  for (const worker of eligibleWorkers) {
    const slots = free(worker, request.platform);
    if (slots <= 0) continue;
    if (best === undefined || slots > best.free) best = { free: slots, workerId: worker.id };
  }
  return best === undefined ? undefined : { reason: "free-capacity", workerId: best.workerId };
}

/** mulberry32: a small seeded PRNG, so a failing fleet reproduces from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MODELS = ["iPhone 17", "iPhone 15", "Pixel 9"] as const;
const RUNTIMES = ["26.0", "18.0", "15"] as const;
const PLATFORMS = ["ios", "android"] as const;

function generateFleet(random: () => number): {
  readonly request: RoutableRequest;
  readonly workers: WorkerView[];
} {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const some = <T>(values: readonly T[]): T[] => values.filter(() => random() < 0.5);
  const base = statusFixture().capacity;
  const slots = () => ({
    ...base.ios,
    maxRunning: Math.floor(random() * 4),
    reserved: Math.floor(random() * 2),
    running: Math.floor(random() * 3),
  });

  const count = Math.floor(random() * 6);
  const workers: WorkerView[] = [];
  for (let index = 0; index < count; index++) {
    const capacity = { ...base, android: slots(), ios: slots() };
    const catalog = catalogFixture(
      some(PLATFORMS).map((platform) => ({
        models: some(MODELS),
        platform,
        runtimes: some(RUNTIMES),
      })),
    ).platforms;
    const devices = Array.from({ length: Math.floor(random() * 3) }, (_, n) => ({
      id: `dev_${index}_${n}`,
      mode: pick(["slim", "full"] as const),
      spec: { model: pick(MODELS), osVersion: pick(RUNTIMES), platform: pick(PLATFORMS) },
      state: pick(["ready", "leased"] as const),
    }));
    const downloadsRoll = random();
    workers.push({
      catalog,
      connection: pick([
        "connected",
        "connected",
        "connected",
        "disconnected",
        "incompatible",
      ] as const),
      devices,
      drained: random() < 0.15,
      id: `wrk_${index}`,
      lastSeenAt: 1,
      leases: [],
      ...(random() < 0.1 ? {} : { capacity }),
      ...(downloadsRoll < 0.25
        ? {}
        : { downloads: { policy: pick(["never", "on-request", "always"] as const) } }),
    });
  }

  const osVersion = random() < 0.3 ? undefined : pick(RUNTIMES);
  const request: RoutableRequest = {
    allowDownload: random() < 0.3,
    model: pick(MODELS),
    platform: pick(PLATFORMS),
    ...(osVersion === undefined ? {} : { osVersion }),
  };
  return { request, workers };
}

const REQUEST = {
  allowDownload: false,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios" as const,
};

function view(id: string, overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    connection: "connected",
    devices: [],
    drained: false,
    id,
    lastSeenAt: 1,
    leases: [],
    ...overrides,
  };
}

function withFreeIos(free: number): WorkerView["capacity"] {
  return {
    ...statusFixture().capacity,
    ios: { ...statusFixture().capacity.ios, maxRunning: free },
  };
}

describe("warm-then-free as a list of stages", () => {
  it("the composed three-stage list picks the same worker and reason as the function on main for every generated fleet", () => {
    const policy = createRoutingPolicy("warm-then-free");
    const outcomes = new Set<string>();

    for (let seed = 1; seed <= 5_000; seed++) {
      const { request, workers } = generateFleet(prng(seed));
      const expected = legacyWarmThenFree(request, workers);
      const actual = policy.select(request, workers);

      expect(
        actual === undefined ? undefined : { reason: actual.reason, workerId: actual.workerId },
        `seed ${seed}`,
      ).toEqual(expected);
      if (actual !== undefined) expect(actual.stage, `seed ${seed}`).toBe(actual.reason);
      outcomes.add(expected === undefined ? "none" : expected.reason);
    }

    // The generator must reach every outcome, or the comparison above proves less than it says.
    expect([...outcomes].sort()).toEqual(["free-capacity", "none", "warm-hit"]);
  });

  it("removing warm-hit from the list sends a request to the freest worker although another holds a warm device", () => {
    const warm = view("wrk_a", {
      capacity: withFreeIos(1),
      devices: [deviceFixture("dev_1", "ready")],
    });
    const freest = view("wrk_b", { capacity: withFreeIos(5) });

    expect(createRoutingPolicy("warm-then-free").select(REQUEST, [warm, freest])?.workerId).toBe(
      "wrk_a",
    );
    expect(composeRoutingPolicy([eligible, freeCapacity]).select(REQUEST, [warm, freest])).toEqual({
      reason: "free-capacity",
      stage: "free-capacity",
      workerId: "wrk_b",
    });
  });

  it("free-capacity scores a worker whose capacity was never read as zero, so it abstains without eligible in front", () => {
    const { capacity: _capacity, ...unread } = view("wrk_a");

    expect(freeCapacity.score(unread, REQUEST)).toBe(0);
    expect(composeRoutingPolicy([freeCapacity]).select(REQUEST, [unread])).toBeUndefined();
  });

  it("adding a filter stage defined in the test drops the workers it rejects, with no other stage edited", () => {
    const rejectRoomy: FilterStage = {
      keeps: (worker) => worker.id !== "wrk_roomy",
      kind: "filter",
      name: "not-roomy",
    };
    const roomy = view("wrk_roomy", { capacity: withFreeIos(9) });
    const tight = view("wrk_tight", { capacity: withFreeIos(2) });

    expect(createRoutingPolicy("warm-then-free").select(REQUEST, [roomy, tight])?.workerId).toBe(
      "wrk_roomy",
    );
    expect(
      composeRoutingPolicy([eligible, rejectRoomy, warmHit, freeCapacity]).select(REQUEST, [
        roomy,
        tight,
      ]),
    ).toEqual({ reason: "free-capacity", stage: "free-capacity", workerId: "wrk_tight" });
  });
});
