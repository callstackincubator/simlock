import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { SLIM_CATEGORIES, labelsFor } from "../src/drivers/ios/slim-labels.js";
import { waitFor, waitForDeviceState, withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";

const execFileAsync = promisify(execFile);

interface SimctlDevice {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
}

interface LeaseGrant {
  readonly lease: string;
  readonly udid: string;
  readonly slim: boolean;
  readonly device: string;
  readonly os: string;
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
}

async function simctlDevices(): Promise<SimctlDevice[]> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout) as { devices: Record<string, SimctlDevice[]> };
  return Object.values(parsed.devices).flat();
}

async function deleteStraySimlockSimulators(): Promise<void> {
  const devices = await simctlDevices();
  for (const device of devices) {
    if (device.name.startsWith("simlock-")) {
      await execFileAsync("xcrun", ["simctl", "delete", device.udid]).catch(() => undefined);
    }
  }
}

/**
 * Parses `xcrun simctl spawn <udid> launchctl print-disabled system`, which prints lines like
 * `		"com.apple.foo" => disabled` / `=> enabled` (verified live on this machine, iOS 26.4.1).
 * Returns only the labels currently disabled.
 */
async function printDisabled(udid: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", [
    "simctl",
    "spawn",
    udid,
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
async function processCount(udid: string): Promise<number> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]);
  return stdout.split("\n").filter((line) => line.trim() !== "").length;
}

async function catalogModelAndOs(env: TestEnv): Promise<{ model: string; os: string }> {
  const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
  expect(catalog.code, `catalog failed: ${catalog.stderr}`).toBe(0);
  const platforms = (catalog.json as { platforms: CatalogPlatform[] }).platforms;
  const iosCatalog = platforms.find((platform) => platform.platform === "ios");
  expect(iosCatalog, "simlock catalog reported no iOS platform").toBeDefined();
  const model = iosCatalog?.models[0];
  const os = iosCatalog?.runtimes[0];
  expect(model, "simlock catalog reported no iOS models").toBeDefined();
  expect(os, "simlock catalog reported no iOS runtimes").toBeDefined();
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
  return lease.json as LeaseGrant;
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
      "scenario 1: slim off (default) is byte-for-byte today's behaviour",
      { timeout: 300_000 },
      async () => {
        const env = await withDaemon({ driver: "real" });
        try {
          const { model, os } = await catalogModelAndOs(env);
          const grant = await leaseDetached(env, model, os, "slim-off-default");

          expect(grant.slim, "grant.slim must be false when ios.slim is not configured").toBe(
            false,
          );

          const disabled = await printDisabled(grant.udid);
          const overlap = [...ALL_LABELS].filter((label) => disabled.has(label));
          expect(
            overlap,
            `expected none of the slim label set disabled on a non-slim device, found: ${overlap.join(", ")}`,
          ).toEqual([]);

          const recorded = await env.events("1h");
          const slimmedEvents = recorded.filter((event) => event.event === "device.slimmed");
          expect(slimmedEvents, "no device.slimmed event expected with slim off").toEqual([]);

          const doctorReport = (await env.cli(["doctor"])).json as DoctorReport;
          const advisories = doctorReport.findings.filter(
            (finding) => finding.kind === "driver-advisory",
          );
          expect(advisories, "no driver-advisory finding expected with slim off").toEqual([]);

          await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
        } finally {
          await deleteStraySimlockSimulators();
        }
      },
    );

    it(
      "scenario 2/3/4/7: cold slim lease, idempotence across a reclaim, --full opt-out, and doctor advisory absence",
      { timeout: 900_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { ios: { slim: { enabled: true } } },
        });
        try {
          const { model, os } = await catalogModelAndOs(env);

          // --- scenario 4 half A + baseline process count: a --full lease is untouched. ---
          const fullStart = Date.now();
          const fullGrant = await leaseDetached(env, model, os, "slim-full-opt-out", ["--full"]);
          const fullDurationMs = Date.now() - fullStart;
          expect(fullGrant.slim, "a --full lease must never be slim").toBe(false);
          const fullDisabled = await printDisabled(fullGrant.udid);
          const fullOverlap = [...ALL_LABELS].filter((label) => fullDisabled.has(label));
          expect(
            fullOverlap,
            `--full device must have none of the slim labels disabled, found: ${fullOverlap.join(", ")}`,
          ).toEqual([]);
          const fullProcessCount = await processCount(fullGrant.udid);

          const doctorAfterFull = (await env.cli(["doctor"])).json as DoctorReport;
          const driftForFull = doctorAfterFull.findings.filter(
            (finding) => finding.kind !== "driver-advisory" && finding.deviceId !== undefined,
          );
          expect(
            driftForFull.filter((finding) => finding.deviceId === fullGrant.udid),
            "doctor must report no drift for the --full device",
          ).toEqual([]);

          // --- scenario 2: a cold, non-full lease produces a slim device. ---
          const eventsBeforeSlim = await env.events("1h");
          const slimmedBefore = eventsBeforeSlim.filter(
            (event) => event.event === "device.slimmed",
          ).length;

          const slimStart = Date.now();
          const slimGrant = await leaseDetached(env, model, os, "slim-cold");
          const slimDurationMs = Date.now() - slimStart;

          expect(slimGrant.slim, "a plain lease under ios.slim.enabled must be slim").toBe(true);
          expect(slimGrant.udid).not.toBe(fullGrant.udid);

          const slimDisabled = await printDisabled(slimGrant.udid);
          const missing = [...ALL_LABELS].filter((label) => !slimDisabled.has(label));
          expect(
            missing.length,
            `expected every slim label disabled on a slim device, missing ${missing.length} of ${ALL_LABELS.size}: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "..." : ""}`,
          ).toBe(0);

          const boot = await simctlDevices();
          expect(boot.find((device) => device.udid === slimGrant.udid)?.state).toBe("Booted");

          const slimProcessCount = await processCount(slimGrant.udid);
          const reduction = 1 - slimProcessCount / fullProcessCount;
          expect(
            reduction,
            `expected the slim device's launchctl job count (${String(slimProcessCount)}) to be ` +
              `at least 30% lower than the full device's (${String(fullProcessCount)}), got a ` +
              `${(reduction * 100).toFixed(1)}% reduction`,
          ).toBeGreaterThanOrEqual(0.3);

          const eventsAfterSlim = await env.expectEvents(["device.slimmed"], { since: "1h" });
          const slimmedEvents = eventsAfterSlim.filter((event) => event.event === "device.slimmed");
          expect(slimmedEvents.length).toBe(slimmedBefore + 1);
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

          // --- scenario 3: release, then re-lease the same spec. Per docs/known-pitfalls.md
          // ("Every reclaim pays two boots, indefinitely"), IosSimctlDriver.reclaim always runs
          // `simctl erase`, wiping the launchctl overrides -- so the documented behaviour is
          // that the warm-pooled device comes back stock and pays a SECOND device.slimmed, not
          // that it's skipped. We assert that documented behaviour here.
          const releaseResult = await env.cli(["release", slimGrant.lease]);
          expect(releaseResult.code).toBe(0);
          await waitForDeviceState(env, slimGrant.udid, "ready", { timeout: 120_000 });

          const relet = await leaseDetached(env, model, os, "slim-cold");
          expect(relet.udid, "expected the warm-pooled device to be reused").toBe(slimGrant.udid);
          expect(relet.slim, "re-leased device must still report slim: true").toBe(true);

          const eventsAfterRelease = await env.expectEvents(["device.slimmed", "device.slimmed"], {
            since: "1h",
          });
          const slimmedAfterRelease = eventsAfterRelease.filter(
            (event) => event.event === "device.slimmed",
          );
          expect(
            slimmedAfterRelease.length,
            "expected a SECOND device.slimmed for this udid after release+re-lease, per the " +
              "documented erase-on-reclaim cost (docs/known-pitfalls.md)",
          ).toBe(slimmedBefore + 2);

          await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
        } finally {
          await deleteStraySimlockSimulators();
        }
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

        const env = await withDaemon({
          driver: "real",
          configOverrides: {
            ios: { slim: { enabled: true, categories: ["siri", "telemetry"] } },
          },
        });
        try {
          const { model, os } = await catalogModelAndOs(env);

          // --- scenario 5 ---
          const grant = await leaseDetached(env, model, os, "slim-subset");
          expect(grant.slim).toBe(true);
          const disabled = await printDisabled(grant.udid);

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
            { ios: { slim: { enabled: true, categories: ["siri", "no-such-category"] } } },
            async () => {
              const grant2 = await leaseDetached(env, model, os, "slim-unknown-category");
              expect(grant2.slim, "lease must still succeed and be slim").toBe(true);
              const disabled2 = await printDisabled(grant2.udid);
              const missingSiri2 = [...siriLabels].filter((label) => !disabled2.has(label));
              expect(missingSiri2, "expected every siri label disabled").toEqual([]);

              await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
            },
          );
        } finally {
          await deleteStraySimlockSimulators();
        }
      },
    );

    it(
      "scenario 8: a health-monitor recovery boot does not re-slim",
      { timeout: 600_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: {
            ios: { slim: { enabled: true } },
            health: { probeIntervalMs: 2_000, recoveryBackoffMs: 1_000, stableObservations: 1 },
          },
        });
        try {
          const { model, os } = await catalogModelAndOs(env);
          const grant = await leaseDetached(env, model, os, "slim-recovery", []);
          expect(grant.slim).toBe(true);
          const disabledBefore = await printDisabled(grant.udid);
          expect([...ALL_LABELS].filter((label) => !disabledBefore.has(label)).length).toBe(0);

          const eventsBefore = await env.events("1h");
          const slimmedBefore = eventsBefore.filter(
            (event) => event.event === "device.slimmed",
          ).length;

          // Pull the device out from under simlock, exactly as leased-device-crash-recovery.test.ts
          // does with the fake driver -- here with the real simctl toolchain.
          await execFileAsync("xcrun", ["simctl", "shutdown", grant.udid]);

          await env.expectEvents(["device.crash-detected", "device.recovered"], {
            since: "1h",
            timeout: 180_000,
          });

          const booted = await simctlDevices();
          expect(booted.find((device) => device.udid === grant.udid)?.state).toBe("Booted");

          const disabledAfter = await printDisabled(grant.udid);
          const missingAfter = [...ALL_LABELS].filter((label) => !disabledAfter.has(label));
          expect(missingAfter, "expected the device to still be fully slim after recovery").toEqual(
            [],
          );

          const eventsAfter = await env.events("1h");
          const slimmedAfter = eventsAfter.filter(
            (event) => event.event === "device.slimmed",
          ).length;
          expect(
            slimmedAfter,
            "recovery must not fire a new device.slimmed (recover purpose never slims)",
          ).toBe(slimmedBefore);

          await env.cli(["release", grant.lease]).catch(() => undefined);
          await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
        } finally {
          await deleteStraySimlockSimulators();
        }
      },
    );

    it("scenario 9: MCP carries the slim flag both ways", { timeout: 600_000 }, async () => {
      const env = await withDaemon({
        driver: "real",
        configOverrides: { ios: { slim: { enabled: true } } },
      });
      try {
        const { model, os } = await catalogModelAndOs(env);
        const mcp = await env.mcpClient({ env: { SIMLOCK_AGENT_ID: "slim-mcp" } });
        try {
          // The SDK's default request timeout is 60s; a cold slim lease takes ~160s on this
          // machine (two real boots). Simlock relays boot progress as MCP progress
          // notifications, so a client that resets its timeout on progress survives it --
          // which is what a real agent's client must do too (see docs/known-pitfalls.md).
          const leaseCallOptions = { resetTimeoutOnProgress: true, timeout: 600_000 };
          const fullResult = await mcp.client.callTool(
            {
              name: "lease_simulator",
              arguments: { platform: "ios", device: model, os, full: true },
            },
            undefined,
            leaseCallOptions,
          );
          const fullLeased = fullResult.structuredContent as {
            lease_id: string;
            slim: boolean;
          };
          expect(fullLeased.slim, "MCP full:true lease must report slim:false").toBe(false);

          await mcp.client.callTool({
            name: "release_simulator",
            arguments: { lease_id: fullLeased.lease_id },
          });

          const slimResult = await mcp.client.callTool(
            {
              name: "lease_simulator",
              arguments: { platform: "ios", device: model, os },
            },
            undefined,
            leaseCallOptions,
          );
          const slimLeased = slimResult.structuredContent as {
            lease_id: string;
            slim: boolean;
          };
          expect(
            slimLeased.slim,
            "MCP plain lease under ios.slim.enabled must report slim:true",
          ).toBe(true);

          await mcp.client.callTool({
            name: "release_simulator",
            arguments: { lease_id: slimLeased.lease_id },
          });
        } finally {
          await mcp.close();
        }

        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 });
      } finally {
        await deleteStraySimlockSimulators();
      }

      // HTTP is skipped here: it needs a real reserved port plus its own auth-token setup
      // (see http-api.test.ts) on top of another real cold iOS lease, which -- given MCP
      // already exercises the same `grant.slim` plumbing through a second transport -- was
      // judged not worth a third real boot cycle in this already-expensive slow lane.
    });

    it("no simlock- simulator remains after this file's flows", { timeout: 60_000 }, async () => {
      await waitFor(
        async () => !(await simctlDevices()).some((device) => device.name.startsWith("simlock-")),
        { timeout: 30_000, label: "no simlock- simulator left behind" },
      );
    });
  },
);
