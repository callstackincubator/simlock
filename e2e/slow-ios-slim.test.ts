import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { SLIM_CATEGORIES, labelsFor } from "../src/drivers/ios/slim-labels.js";
import { waitForDeviceState, withDaemon } from "./helpers/index.js";
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

interface DoctorReport {
  readonly findings: readonly {
    readonly kind: string;
    readonly code?: string;
    readonly platform?: string;
    readonly deviceId?: string;
  }[];
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
      "scenario 1: on a default-full worker a request with no mode is full, and --mode slim is slim",
      { timeout: 600_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withRealDaemon();
        const { model, os } = await catalogModelAndOs(env);
        const grant = await leaseDetached(env, model, os, "default-full");

        expect(grant.mode, "a request with no mode must be full on a default-full worker").toBe(
          "full",
        );

        const disabled = await printDisabled(grant);
        const overlap = [...ALL_LABELS].filter((label) => disabled.has(label));
        expect(
          overlap,
          `expected none of the slim label set disabled on a full device, found: ${overlap.join(", ")}`,
        ).toEqual([]);

        const recorded = await env.events("1h");
        const slimmedEvents = recorded.filter((event) => event.event === "device.slimmed");
        expect(slimmedEvents, "no device.slimmed event expected for a full device").toEqual([]);

        const doctorReport = (await env.cli(["doctor"])).json as DoctorReport;
        const advisories = doctorReport.findings.filter(
          (finding) => finding.kind === "driver-advisory",
        );
        expect(advisories, "no driver-advisory finding expected on a default-full worker").toEqual(
          [],
        );

        expect((await env.cli(["release", grant.lease])).code).toBe(0);

        const slimGrant = await leaseDetached(env, model, os, "default-full-asks-slim", [
          "--mode",
          "slim",
        ]);
        await expectSlim(env, slimGrant.mode, "--mode slim must be slim on a default-full worker");
        expect(slimGrant.udid, "a slim request must not reuse the idle full device").not.toBe(
          grant.udid,
        );
        const slimDisabled = await printDisabled(slimGrant);
        expect([...ALL_LABELS].filter((label) => !slimDisabled.has(label))).toEqual([]);

        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );

    it(
      "scenario 2/3/4/7: on a default-slim worker, a cold slim lease, --mode full while a slim device sits idle, idempotence across a reclaim, and doctor advisory absence",
      { timeout: 900_000 },
      async () => {
        const env = await withRealDaemon({ ios: { defaultMode: "slim" } });
        const { model, os } = await catalogModelAndOs(env);

        // --- scenario 2: a cold lease naming no mode produces a slim device. ---
        const slimStart = Date.now();
        const slimGrant = await leaseDetached(env, model, os, "slim-cold");
        const slimDurationMs = Date.now() - slimStart;

        await expectSlim(env, slimGrant.mode, "a slim lease's grant must carry mode: slim");

        const slimDisabled = await printDisabled(slimGrant);
        const missing = [...ALL_LABELS].filter((label) => !slimDisabled.has(label));
        expect(
          missing.length,
          `expected every slim label disabled on a slim device, missing ${missing.length} of ${ALL_LABELS.size}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`,
        ).toBe(0);

        const boot = await setDevices(slimGrant.deviceSet);
        expect(boot.find((device) => device.udid === slimGrant.udid)?.state).toBe("Booted");
        const slimProcessCount = await processCount(slimGrant);

        const eventsAfterSlim = await env.expectEvents(["device.slimmed"], { since: "1h" });
        const slimmedEvents = eventsAfterSlim.filter((event) => event.event === "device.slimmed");
        expect(slimmedEvents.length).toBe(1);

        // --- scenario 4: with the slim device released and idle in the pool, --mode full gets
        // a different, full device. ---
        expect((await env.cli(["release", slimGrant.lease])).code).toBe(0);
        await waitForDeviceState(env, slimGrant.udid, "ready", { timeout: 120_000 });

        const fullStart = Date.now();
        const fullGrant = await leaseDetached(env, model, os, "slim-full", ["--mode", "full"]);
        const fullDurationMs = Date.now() - fullStart;
        expect(fullGrant.mode, "a --mode full lease's grant must carry mode: full").toBe("full");
        expect(fullGrant.udid, "--mode full must not receive the idle slim device").not.toBe(
          slimGrant.udid,
        );
        const fullDisabled = await printDisabled(fullGrant);
        const fullOverlap = [...ALL_LABELS].filter((label) => fullDisabled.has(label));
        expect(
          fullOverlap,
          `--mode full device must have none of the slim labels disabled, found: ${fullOverlap.join(", ")}`,
        ).toEqual([]);
        const fullProcessCount = await processCount(fullGrant);

        const doctorAfterFull = (await env.cli(["doctor"])).json as DoctorReport;
        expect(
          doctorAfterFull.findings.filter((finding) => finding.deviceId === fullGrant.udid),
          "doctor must report no drift for the full device",
        ).toEqual([]);

        const reduction = 1 - slimProcessCount / fullProcessCount;
        expect(
          reduction,
          `expected the slim device's launchctl job count (${String(slimProcessCount)}) to be ` +
            `at least 30% lower than the full device's (${String(fullProcessCount)}), got a ` +
            `${(reduction * 100).toFixed(1)}% reduction`,
        ).toBeGreaterThanOrEqual(0.3);

        const slimmedFact = slimmedEvents.at(-1)?.payload as {
          deviceId: string;
          platform?: string;
          categories: readonly string[];
          labelCount: number;
          unknownLabels: readonly string[];
        };
        expect(slimmedFact.categories.length, "expected every category resolved").toBe(
          SLIM_CATEGORIES.length,
        );
        expect(new Set(slimmedFact.categories)).toEqual(ALL_CATEGORY_NAMES);
        expect(slimmedFact.labelCount).toBe(ALL_LABELS.size);
        // Reported, not asserted empty -- known-pitfalls.md documents that Apple drift can
        // legitimately produce rejected labels here; this is evidence for the report, not a
        // pass/fail condition.
        // eslint-disable-next-line no-console
        console.log(
          `[slim e2e] scenario 2 unknownLabels (${slimmedFact.unknownLabels.length}): ` +
            JSON.stringify(slimmedFact.unknownLabels),
        );

        console.log(
          `[slim e2e] lease duration: full=${String(fullDurationMs)}ms slim(cold)=${String(slimDurationMs)}ms; ` +
            `process count: full=${String(fullProcessCount)} slim=${String(slimProcessCount)} ` +
            `(${(reduction * 100).toFixed(1)}% reduction)`,
        );

        // --- scenario 7: doctor advisory is absent (both installed runtimes are >= 18.5). ---
        const doctorAfterSlim = (await env.cli(["doctor"])).json as DoctorReport;
        const advisories = doctorAfterSlim.findings.filter(
          (finding) => finding.kind === "driver-advisory",
        );
        expect(
          advisories,
          "expected no slim-runtime-unsupported advisory: both installed runtimes on this " +
            "machine (26.4.1, 27.0) are >= 18.5",
        ).toEqual([]);

        // --- scenario 3: re-lease the released slim spec. Per docs/internal/KNOWN-PITFALLS.md
        // ("Every reclaim pays two boots, indefinitely"), IosSimctlDriver.reclaim always runs
        // `simctl erase`, wiping the launchctl overrides -- so the documented behaviour is
        // that the warm-pooled device comes back stock and pays a SECOND device.slimmed, not
        // that it's skipped. We assert that documented behaviour here.
        const relet = await leaseDetached(env, model, os, "slim-cold");
        expect(relet.udid, "expected the warm-pooled device to be reused").toBe(slimGrant.udid);
        await expectSlim(env, relet.mode, "re-leased device must still report mode: slim");

        const eventsAfterRelease = await env.expectEvents(["device.slimmed", "device.slimmed"], {
          since: "1h",
        });
        const slimmedAfterRelease = eventsAfterRelease.filter(
          (event) => event.event === "device.slimmed",
        );
        expect(
          slimmedAfterRelease.length,
          "expected a SECOND device.slimmed for this udid after release+re-lease, per the " +
            "documented erase-on-reclaim cost (docs/internal/KNOWN-PITFALLS.md)",
        ).toBe(2);

        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      },
    );

    it(
      "scenario 5/6: a categories subset disables only its own labels, and an unknown category is not fatal",
      { timeout: 900_000 },
      async () => {
        const siriLabels = new Set(
          labelsFor(SLIM_CATEGORIES.filter((category) => category.name === "siri")),
        );
        const telemetryLabels = new Set(
          labelsFor(SLIM_CATEGORIES.filter((category) => category.name === "telemetry")),
        );
        const photosLabels = new Set(
          labelsFor(SLIM_CATEGORIES.filter((category) => category.name === "photos")),
        );

        const env = await withRealDaemon({
          ios: { defaultMode: "slim", slim: { categories: ["siri", "telemetry"] } },
        });
        const { model, os } = await catalogModelAndOs(env);

        // --- scenario 5 ---
        const grant = await leaseDetached(env, model, os, "slim-subset");
        await expectSlim(env, grant.mode, "a default-slim lease must be slim");
        const disabled = await printDisabled(grant);

        const missingSiri = [...siriLabels].filter((label) => !disabled.has(label));
        const missingTelemetry = [...telemetryLabels].filter((label) => !disabled.has(label));
        expect(missingSiri, "expected every siri label disabled").toEqual([]);
        expect(missingTelemetry, "expected every telemetry label disabled").toEqual([]);

        const leakedPhotos = [...photosLabels].filter((label) => disabled.has(label));
        expect(
          leakedPhotos,
          `expected no photos-category label disabled, found: ${leakedPhotos.join(", ")}`,
        ).toEqual([]);

        const recorded = await env.expectEvents(["device.slimmed"], { since: "1h" });
        const fact = recorded.find((event) => event.event === "device.slimmed")?.payload as {
          categories: readonly string[];
        };
        expect(fact.categories).toEqual(["siri", "telemetry"]);

        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });

        // --- scenario 6: an unknown category alongside a known one is not fatal. ---
        await env.withConfig(
          { ios: { defaultMode: "slim", slim: { categories: ["siri", "no-such-category"] } } },
          async () => {
            const grant2 = await leaseDetached(env, model, os, "slim-unknown-category");
            await expectSlim(env, grant2.mode, "lease must still succeed and be slim");
            const disabled2 = await printDisabled(grant2);
            const missingSiri2 = [...siriLabels].filter((label) => !disabled2.has(label));
            expect(missingSiri2, "expected every siri label disabled").toEqual([]);

            await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
          },
        );
      },
    );

    it(
      "scenario 8: a health-monitor recovery boot does not re-slim",
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

    it("scenario 9: MCP carries the device mode both ways", { timeout: 600_000 }, async () => {
      const env = await withRealDaemon({ ios: { defaultMode: "slim" } });
      const { model, os } = await catalogModelAndOs(env);
      const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "slim-mcp" } });
      try {
        // The SDK's default request timeout is 60s; a cold slim lease takes ~160s on this
        // machine (two real boots). Simlock relays boot progress as MCP progress
        // notifications, so a client that resets its timeout on progress survives it --
        // which is what a real agent's client must do too (see docs/internal/KNOWN-PITFALLS.md).
        const leaseCallOptions = { resetTimeoutOnProgress: true, timeout: 600_000 };
        const fullResult = await mcp.client.callTool(
          {
            name: "lease_simulator",
            arguments: { mode: "full", model, osVersion: os, platform: "ios" },
          },
          undefined,
          leaseCallOptions,
        );
        const fullLeased = fullResult.structuredContent as {
          device: { mode: "slim" | "full" };
          lease: { id: string };
        };
        expect(fullLeased.device.mode, "MCP mode: full lease must report mode: full").toBe("full");

        await mcp.client.callTool({
          name: "release_simulator",
          arguments: { leaseId: fullLeased.lease.id },
        });

        const slimResult = await mcp.client.callTool(
          {
            name: "lease_simulator",
            arguments: { model, osVersion: os, platform: "ios" },
          },
          undefined,
          leaseCallOptions,
        );
        const slimLeased = slimResult.structuredContent as {
          device: { mode: "slim" | "full" };
          lease: { id: string };
        };
        await expectSlim(
          env,
          slimLeased.device.mode,
          "MCP lease naming no mode on a default-slim worker must report mode: slim",
        );

        await mcp.client.callTool({
          name: "release_simulator",
          arguments: { leaseId: slimLeased.lease.id },
        });
      } finally {
        await mcp.close();
      }

      await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });

      // HTTP is skipped here: it needs a real reserved port plus its own auth-token setup
      // (see http-api.test.ts) on top of another real cold iOS lease, which -- given MCP
      // already exercises the same `grant.device.mode` plumbing through a second transport -- was
      // judged not worth a third real boot cycle in this already-expensive slow lane.
    });

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
