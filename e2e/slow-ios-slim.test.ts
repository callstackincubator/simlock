import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { SLIM_CATEGORIES, labelsFor } from "../src/drivers/ios/index.js";
import { withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";
import {
  iosDeviceSet,
  processesInDeviceSet,
  setDevices,
  simctlInSet,
  sweepStaleDeviceSets,
} from "./helpers/ios-device-set.js";

/** The fields of a `simlock lease --detach` grant this lane reads, flattened. */
interface LeaseGrant {
  readonly lease: string;
  readonly udid: string;
  readonly mode: "slim" | "full";
  /** The device set the grant says the device lives in; no simctl call reaches it without. */
  readonly deviceSet: string;
}

interface CatalogPlatform {
  readonly platform: string;
  readonly models: readonly string[];
  readonly runtimes: readonly string[];
  readonly modelRuntimes: Readonly<Record<string, readonly string[]>>;
}

/**
 * Every device set a test in this file handed to `withDaemon`, so the last test can check that
 * none of them still runs a simulator once teardown has emptied it.
 */
const usedDeviceSets: string[] = [];

/** Starts the real-driver daemon for one test and records its device set. */
async function withRealDaemon(configOverrides: Record<string, unknown> = {}): Promise<TestEnv> {
  const env = await withDaemon({ driver: "real", configOverrides });
  usedDeviceSets.push(iosDeviceSet(env.home));
  return env;
}

/**
 * Parses `xcrun simctl --set <set> spawn <udid> launchctl print-disabled system`, which prints lines like
 * `		"com.apple.foo" => disabled` / `=> enabled` (verified live on this machine, iOS 26.4.1).
 * Returns only the labels currently disabled.
 */
async function printDisabled(grant: LeaseGrant): Promise<Set<string>> {
  const { stdout } = await simctlInSet(grant.deviceSet, [
    "spawn",
    grant.udid,
    "launchctl",
    "print-disabled",
    "system",
  ]);
  const disabled = new Set<string>();
  const pattern = /"([^"]+)"\s*=>\s*disabled/g;
  for (const match of stdout.matchAll(pattern)) {
    const label = match[1];
    if (label !== undefined) disabled.add(label);
  }
  return disabled;
}

/**
 * Count of launchd jobs the simulator's own launchd is managing, via `launchctl list` run
 * *inside* the simulator through `simctl spawn` (not `ps` on the host, which would count host
 * processes across every booted simulator indiscriminately). One line per job plus a header
 * line; good enough as a relative, before/after comparison -- this test never asserts an
 * absolute count, only that a slim device's count is materially lower than a full device's.
 */
async function processCount(grant: LeaseGrant): Promise<number> {
  const { stdout } = await simctlInSet(grant.deviceSet, ["spawn", grant.udid, "launchctl", "list"]);
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

async function catalogModelAndOs(env: TestEnv): Promise<{ model: string; os: string }> {
  const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
  expect(catalog.code, `catalog failed: ${catalog.stderr}`).toBe(0);
  const platforms = (catalog.json as { platforms: CatalogPlatform[] }).platforms;
  const iosCatalog = platforms.find((platform) => platform.platform === "ios");
  expect(iosCatalog, "simlock catalog reported no iOS platform").toBeDefined();
  // A listed model and a listed runtime need not pair, so take a pair the catalog lists.
  const model = iosCatalog?.models.find(
    (name) => (iosCatalog.modelRuntimes[name]?.length ?? 0) > 0,
  );
  expect(model, "simlock catalog paired no iOS model with an installed runtime").toBeDefined();
  const os = iosCatalog?.modelRuntimes[model as string]?.[0];
  return { model: model as string, os: os as string };
}

async function leaseDetached(
  env: TestEnv,
  model: string,
  os: string,
  agentId: string,
  extraArgs: readonly string[] = [],
): Promise<LeaseGrant> {
  const lease = await env.cli(
    [
      "lease",
      "--platform",
      "ios",
      "--device",
      model,
      "--os",
      os,
      "--agent-id",
      agentId,
      "--detach",
      ...extraArgs,
    ],
    { timeout: 600_000 },
  );
  expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
  const grant = lease.json as {
    device: { driverDeviceId: string; mode: "slim" | "full" };
    environment: Record<string, string>;
    lease: { id: string };
  };
  const deviceSet = grant.environment.SIMLOCK_IOS_DEVICE_SET;
  expect(deviceSet, "an iOS grant must name the device set its device lives in").toBeDefined();
  return {
    deviceSet: deviceSet as string,
    lease: grant.lease.id,
    mode: grant.device.mode,
    udid: grant.device.driverDeviceId,
  };
}

/**
 * The daemon's own account of every slim it skipped. A grant that comes back `full` where
 * `slim` was expected says nothing about why; these lines do, so they go in the message.
 */
async function slimSkips(env: TestEnv): Promise<string> {
  const log = await readFile(env.logPath, "utf8").catch(() => "");
  const skips = log.split("\n").filter((line) => line.includes("Skipped iOS device slim"));
  return skips.length === 0 ? "the daemon logged no skipped slim" : skips.join("\n");
}

async function expectSlim(env: TestEnv, mode: LeaseGrant["mode"], message: string): Promise<void> {
  expect(mode, `${message}\n${mode === "slim" ? "" : await slimSkips(env)}`).toBe("slim");
}

const ALL_LABELS = new Set(labelsFor(SLIM_CATEGORIES));
const ALL_CATEGORY_NAMES = new Set(SLIM_CATEGORIES.map((category) => category.name));

// This lane needs the real simctl toolchain and real launchd behaviour inside the simulator,
// hence darwin-only. Never installs a runtime itself (no --allow-download).
describe.skipIf(process.platform !== "darwin")(
  "iOS slim mode (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "on a default-slim worker, a cold lease naming no mode boots slim with every label disabled, and runs at least 30% fewer launchd jobs than a --mode full device beside it",
      { timeout: 900_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withRealDaemon({ ios: { defaultMode: "slim" } });
        const { model, os } = await catalogModelAndOs(env);

        const slimStart = Date.now();
        const slimGrant = await leaseDetached(env, model, os, "slim-cold");
        const slimDurationMs = Date.now() - slimStart;
        await expectSlim(env, slimGrant.mode, "a lease naming no mode must be slim");

        // What only a real simulator can show: launchd took every label, and the overrides
        // survived the reboot that makes them take effect.
        const slimDisabled = await printDisabled(slimGrant);
        const missing = [...ALL_LABELS].filter((label) => !slimDisabled.has(label));
        expect(
          missing.length,
          `expected every slim label disabled on a slim device, missing ${missing.length} of ${ALL_LABELS.size}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`,
        ).toBe(0);
        const booted = await setDevices(slimGrant.deviceSet);
        expect(booted.find((device) => device.udid === slimGrant.udid)?.state).toBe("Booted");

        const recorded = await env.expectEvents(["device.slimmed"], { since: "1h" });
        const slimmedEvents = recorded.filter((event) => event.event === "device.slimmed");
        expect(slimmedEvents.length).toBe(1);
        const slimmedFact = slimmedEvents[0]?.payload as {
          categories: readonly string[];
          labelCount: number;
          unknownLabels: readonly string[];
        };
        expect(new Set(slimmedFact.categories)).toEqual(ALL_CATEGORY_NAMES);
        expect(slimmedFact.labelCount).toBe(ALL_LABELS.size);
        // Reported, not asserted empty: Apple can rename or drop a daemon between runtimes
        // (docs/internal/KNOWN-PITFALLS.md), and that is evidence for the report, not a failure.
        console.log(
          `[slim e2e] unknownLabels (${slimmedFact.unknownLabels.length}): ` +
            JSON.stringify(slimmedFact.unknownLabels),
        );

        // The slim device stays leased, so the full one is a second device by construction.
        const fullStart = Date.now();
        const fullGrant = await leaseDetached(env, model, os, "full-beside", ["--mode", "full"]);
        const fullDurationMs = Date.now() - fullStart;
        expect(fullGrant.mode, "a --mode full lease's grant must carry mode: full").toBe("full");
        const fullDisabled = await printDisabled(fullGrant);
        const fullOverlap = [...ALL_LABELS].filter((label) => fullDisabled.has(label));
        expect(
          fullOverlap,
          `a full device must have none of the slim labels disabled, found: ${fullOverlap.join(", ")}`,
        ).toEqual([]);

        // The reason slim mode exists: fewer jobs running inside the simulator.
        const slimProcessCount = await processCount(slimGrant);
        const fullProcessCount = await processCount(fullGrant);
        const reduction = 1 - slimProcessCount / fullProcessCount;
        console.log(
          `[slim e2e] lease duration: full=${String(fullDurationMs)}ms slim(cold)=${String(slimDurationMs)}ms; ` +
            `process count: full=${String(fullProcessCount)} slim=${String(slimProcessCount)} ` +
            `(${(reduction * 100).toFixed(1)}% reduction)`,
        );
        expect(
          reduction,
          `expected the slim device's launchctl job count (${String(slimProcessCount)}) to be ` +
            `at least 30% lower than the full device's (${String(fullProcessCount)}), got a ` +
            `${(reduction * 100).toFixed(1)}% reduction`,
        ).toBeGreaterThanOrEqual(0.3);

        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );

    it(
      "a health-monitor recovery boot of a slim device does not re-slim it",
      { timeout: 600_000 },
      async () => {
        const env = await withRealDaemon({
          ios: { defaultMode: "slim" },
          health: { probeIntervalMs: 2_000, recoveryBackoffMs: 1_000, stableObservations: 1 },
        });
        const { model, os } = await catalogModelAndOs(env);
        const grant = await leaseDetached(env, model, os, "slim-recovery", []);
        await expectSlim(env, grant.mode, "a default-slim lease must be slim");
        const disabledBefore = await printDisabled(grant);
        expect([...ALL_LABELS].filter((label) => !disabledBefore.has(label)).length).toBe(0);

        const eventsBefore = await env.events("1h");
        const slimmedBefore = eventsBefore.filter(
          (event) => event.event === "device.slimmed",
        ).length;

        // Pull the device out from under simlock, exactly as leased-device-crash-recovery.test.ts
        // does with the fake driver -- here with the real simctl toolchain.
        await simctlInSet(grant.deviceSet, ["shutdown", grant.udid]);

        await env.expectEvents(["device.crash-detected", "device.recovered"], {
          since: "1h",
          timeout: 180_000,
        });

        const booted = await setDevices(grant.deviceSet);
        expect(booted.find((device) => device.udid === grant.udid)?.state).toBe("Booted");

        const disabledAfter = await printDisabled(grant);
        const missingAfter = [...ALL_LABELS].filter((label) => !disabledAfter.has(label));
        expect(missingAfter, "expected the device to still be fully slim after recovery").toEqual(
          [],
        );

        const eventsAfter = await env.events("1h");
        const slimmedAfter = eventsAfter.filter((event) => event.event === "device.slimmed").length;
        expect(
          slimmedAfter,
          "recovery must not fire a new device.slimmed (recover purpose never slims)",
        ).toBe(slimmedBefore);

        await env.cli(["release", grant.lease]).catch(() => undefined);
        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );

    it(
      "no simulator from this file's device sets is still running after its flows",
      { timeout: 60_000 },
      async () => {
        expect(usedDeviceSets.length, "expected the flows above to have run").toBeGreaterThan(0);
        for (const deviceSet of usedDeviceSets) {
          expect(
            await processesInDeviceSet(deviceSet),
            `a simulator of ${deviceSet} outlived its test`,
          ).toEqual([]);
        }
      },
    );
  },
);
