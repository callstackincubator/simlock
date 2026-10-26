import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import {
  assertPinnedAgentDevice,
  cleanupAgents,
  freeLoopbackPort,
  makeAgent,
  makeProfileAgent,
  openInputSocket,
  newAgentToken,
  waitForAgentDevice,
  waitFor,
  DEVICE_READY_MS,
  withSharedDaemon,
  ANDROID,
  FIRST_SNAPSHOT,
  IOS,
  failureText,
  hasIosRuntime,
  listDevices,
  listLeases,
  listRequests,
  ok,
  progress,
  setLimits,
  succeeds,
  waitForFree,
  warmUp,
  type Agent,
  type AgentDeviceResult,
  type RequestRow,
  type Target,
  type RecordedEvent,
  type SharedTestEnv,
} from "./helpers/index.js";

const AGENT_DEVICE = process.env.SIMLOCK_E2E_AGENT_DEVICE;

const iosAvailable = hasIosRuntime();
const androidAvailable = succeeds("sh", ["-c", "command -v emulator && command -v adb"]);

function refused(result: AgentDeviceResult): void {
  expect(result.code, "the command was accepted").not.toBe(0);
  expect(failureText(result)).toContain("refused:");
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// why: agent-device's snapshot JSON is read for the node whose identifier is `id` and for the largest
// box in it, which is the screen; both are read from the one snapshot so the tap's fraction is
// measured against the size the same snapshot placed the node in.
function boxOf(node: unknown): Box | undefined {
  const rect = (node as { rect?: Box } | null)?.rect;
  return rect !== undefined && typeof rect.width === "number" ? rect : undefined;
}

function* nodesOf(node: unknown): Generator<Record<string, unknown>> {
  if (typeof node !== "object" || node === null) return;
  if (!Array.isArray(node)) yield node as Record<string, unknown>;
  for (const child of Object.values(node)) yield* nodesOf(child);
}

function findBoxes(json: unknown, id: string): { target?: Box; screen?: Box } {
  const boxed = [...nodesOf(json)].flatMap((node) => {
    const box = boxOf(node);
    return box === undefined
      ? []
      : [{ box, named: node["identifier"] === id || node["id"] === id }];
  });
  const area = (box: Box) => box.width * box.height;
  const screen = boxed.map((entry) => entry.box).sort((left, right) => area(right) - area(left))[0];
  const target = boxed.find((entry) => entry.named)?.box;
  return {
    ...(screen === undefined ? {} : { screen }),
    ...(target === undefined ? {} : { target }),
  };
}

function listField(result: AgentDeviceResult, key: string): unknown[] {
  const data = result.data as Record<string, unknown> | undefined;
  const value = data?.[key];
  return Array.isArray(value) ? value : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface PidRecord {
  readonly pid: number;
  readonly entry: string;
}

async function readPidRecord(env: SharedTestEnv): Promise<PidRecord> {
  return JSON.parse(
    await readFile(join(env.home, "agent-device-daemon.json"), "utf8"),
  ) as PidRecord;
}

function killIfStillAgentDevice(record: PidRecord): void {
  if (!isAlive(record.pid)) return;
  const args = execFileSync("ps", ["-ww", "-o", "args=", "-p", String(record.pid)], {
    encoding: "utf8",
  });
  if (args.includes(record.entry)) process.kill(record.pid, "SIGKILL");
}

async function eventAfter(
  env: SharedTestEnv,
  name: string,
  since: number,
  match: (event: RecordedEvent) => boolean = () => true,
): Promise<RecordedEvent | undefined> {
  const all = await env.events();
  return all.find((event) => event.event === name && event.timestamp >= since && match(event));
}

function forLease(leaseId: string | undefined): (event: RecordedEvent) => boolean {
  return (event) => (event.payload as { leaseId?: string }).leaseId === leaseId;
}

function wipeStartOf(reclaimed: RecordedEvent): number {
  return reclaimed.timestamp - (reclaimed.payload as { duration: number }).duration;
}

const sharedEnvs = new Set<SharedTestEnv>();
afterAll(async () => {
  await Promise.allSettled([...sharedEnvs].map((env) => env.teardown()));
  sharedEnvs.clear();
}, 120_000);

function defineSuite(target: Target): void {
  const platform = target.platform;
  let env: SharedTestEnv;

  const agent = (name: string): Promise<Agent> => makeAgent(env, name);
  // why: an open that fails answers within seconds, so it ends the test there instead of leaving the test to wait on a lease nobody holds.
  const tryOpen = (who: Agent) => who.run(["open", "--platform", platform], { timeout: 330_000 });
  const open = async (who: Agent) => {
    const result = await tryOpen(who);
    if (result.code !== 0) {
      throw new Error(`open failed for ${who.name}: ${result.stdout}\n${result.stderr}`);
    }
    return result;
  };

  async function awaitAgentDevice(): Promise<void> {
    const probe = await newAgentToken(env);
    await waitForAgentDevice(env, probe.secret);
  }

  beforeAll(async () => {
    const pinned = await assertPinnedAgentDevice(platform);
    env = await withSharedDaemon({
      driver: "real",
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
        capabilities: {
          "agent-device": { enabled: true, command: pinned },
          input: { enabled: true },
        },
        capacity: {
          config: { limits: { [platform]: { maxDevices: 1, maxRunning: 1 } } },
        },
      },
    });
    sharedEnvs.add(env);
    await awaitAgentDevice();
    await warmUp(env, target, 1);
  }, 420_000);

  afterAll(async () => {
    await env?.teardown();
    sharedEnvs.delete(env);
  }, 120_000);

  beforeEach((context) => {
    progress(`START ${platform}: ${context.task.name.slice(0, 100)}`);
  });

  afterEach((context) => {
    progress(
      `END ${platform} (${context.task.result?.state ?? "unknown"}): ${context.task.name.slice(0, 100)}`,
    );
  });

  afterEach(async () => {
    await cleanupAgents();
    const released = await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
    expect(released.code, released.stderr).toBe(0);
    await waitForFree(env);
  }, 300_000);

  it(
    "an agent opens a device, installs the Appduct fixture app as an upload, opens it by its bundle id, takes a snapshot that shows tab-status, clicks tab-status, saves a PNG screenshot and closes; within 240 s the device is free",
    { timeout: 600_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      ok(await a.run(["install", "Appduct", target.app]));
      ok(await a.run(["open", target.bundleId]));
      const snapshot = await a.run(["snapshot"], FIRST_SNAPSHOT);
      ok(snapshot);
      expect(snapshot.stdout).toContain("tab-status");
      ok(await a.run(["click", 'id="tab-status"']));
      const dir = await mkdtemp(join(tmpdir(), "simlock-ad-shot-"));
      onTestFinished(() => rm(dir, { force: true, recursive: true }));
      const png = join(dir, "shot.png");
      ok(await a.run(["screenshot", png]));
      expect((await readFile(png)).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      ok(await a.run(["close"]));
      await waitForFree(env);
    },
  );

  it(
    "an agent taps the centre of tab-status through the lease's input socket, as agent-device's snapshot places it, and the next snapshot shows the Status tab's screen",
    { timeout: 600_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      ok(await a.run(["install", "Appduct", target.app]));
      ok(await a.run(["open", target.bundleId]));
      const before = await a.run(["snapshot", "--json"], FIRST_SNAPSHOT);
      ok(before);
      // why: the fixture's Status screen alone carries `connection-state` and its Tools screen `call-count` (Appduct at the pin in e2e/fixtures/appduct/README.md:8: playground-native/ios/AppductPlayground/ContentView.swift:61 and :82, playground-native/android/app/src/main/java/com/callstack/appduct/playground/MainActivity.kt:102 and :109).
      expect(before.stdout).toContain("call-count");
      expect(before.stdout).not.toContain("connection-state");
      const { target: tab, screen } = findBoxes(before.json, "tab-status");
      expect(tab, "tab-status in the snapshot").toBeDefined();
      expect(screen, "the screen in the snapshot").toBeDefined();
      const lease = (await listLeases(env))[0];
      const socket = await openInputSocket(env.httpPort, lease?.id ?? "", a.token);
      try {
        await socket.waitForTag(0x83);
        const config = (await socket.waitForTag(0x82)) as { width: number; height: number };
        expect(config.width).toBeGreaterThan(1);
        const x =
          ((tab as Box).x + (tab as Box).width / 2 - (screen as Box).x) / (screen as Box).width;
        const y =
          ((tab as Box).y + (tab as Box).height / 2 - (screen as Box).y) / (screen as Box).height;
        socket.send(0x03, { type: "begin", x, y });
        socket.send(0x03, { type: "end", x, y });
        await waitFor(
          async () => {
            const after = await a.run(["snapshot"]);
            return after.code === 0 && after.stdout.includes("connection-state");
          },
          {
            interval: 2_000,
            label: "a snapshot of the Status screen after the tap",
            timeout: 60_000,
          },
        );
      } finally {
        socket.close();
      }
      ok(await a.run(["close"]));
      await waitForFree(env);
    },
  );

  it(
    "an agent with no token in its environment connects with the worker's profile file, opens a device, installs the fixture app as an upload and closes; the lease's owner is the profile token",
    { timeout: 600_000 },
    async () => {
      const a = await makeProfileAgent(env, "profile");
      ok(await open(a));
      const leases = await listLeases(env);
      expect(leases.map((lease) => lease.ownerId)).toEqual([a.tokenId]);
      ok(await a.run(["install", "Appduct", target.app]));
      ok(await a.run(["close"]));
      await waitForFree(env);
    },
  );

  it(
    "with this working agent-device, simlock doctor reports no module-unavailable finding and no finding whose message names agent-device",
    { timeout: 600_000 },
    async () => {
      const doctor = await env.cli(["doctor"], { timeout: 60_000 });
      const findings = (doctor.json as { findings: { kind: string; message?: string }[] }).findings;
      expect(findings.map((finding) => finding.kind)).not.toContain("module-unavailable");
      expect(findings.filter((finding) => /agent-device/i.test(finding.message ?? ""))).toEqual([]);
    },
  );

  it(
    "close releases the simlock lease before the CLI exits, and a following open works",
    { timeout: 900_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      expect(await listLeases(env)).toHaveLength(1);
      ok(await a.run(["close"]));
      expect(await listLeases(env)).toEqual([]);
      ok(await open(a));
      expect(await listLeases(env)).toHaveLength(1);
    },
  );

  it(
    "after an accepted upload install and snapshot, install from a remote: path, boot, shutdown and snapshot --ios-simulator-device-set <dir> (on Android also --android-device-allowlist <serial>) are refused, and the device is still leased and answers snapshot",
    { timeout: 600_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      ok(await a.run(["install", "Appduct", target.app]));
      // why: an iOS snapshot needs an app session on the device (ios_app_session_required).
      ok(await a.run(["open", target.bundleId]));
      ok(await a.run(["snapshot"], FIRST_SNAPSHOT));
      const [lease] = await listLeases(env);
      const address = (await listDevices(env)).find((device) => device.id === lease?.deviceId)
        ?.address as string;
      const dir = await mkdtemp(join(tmpdir(), "simlock-ad-set-"));
      onTestFinished(() => rm(dir, { force: true, recursive: true }));

      refused(await a.run(["install", "Appduct", "remote:/data/local/tmp/Appduct"]));
      for (const command of ["boot", "shutdown"]) {
        const denied = await a.run([command]);
        expect(denied.code, `${command} was accepted`).not.toBe(0);
        expect(denied.error?.code).toBe("UNAUTHORIZED");
        expect(denied.error?.details?.reason).toBe("DAEMON_POLICY_DENIED");
      }
      for (const flags of target.forbiddenFlags(address, dir)) {
        refused(await a.run(["snapshot", ...flags]));
      }

      expect(await listLeases(env)).toHaveLength(1);
      ok(await a.run(["snapshot"]));
    },
  );

  it(
    "simlock release --all ends the agent's agent-device session before the device is wiped: no session sample starts after the wipe began, the last sample finds no session, another agent's open gets that same device where opening the fixture app fails, and the first agent's next command fails with lease ended by simlock",
    { timeout: 900_000 },
    async () => {
      const a = await agent("a");
      const b = await agent("b");
      ok(await open(a));
      ok(await a.run(["install", "Appduct", target.app]));
      ok(await a.run(["open", target.bundleId]));
      expect(listField(await a.run(["session", "list"]), "sessions").length).toBeGreaterThan(0);
      const [lease] = await listLeases(env);
      const startedAt = Date.now();

      const samples: { at: number; hasSession: boolean }[] = [];
      const sampling = waitFor(
        async () => {
          const at = Date.now();
          const sessions = listField(await a.run(["session", "list"]), "sessions");
          samples.push({ at, hasSession: sessions.length > 0 });
          const devices = await listDevices(env);
          return Date.now() - startedAt > 2_000 && devices.every((d) => d.state === "ready");
        },
        { timeout: DEVICE_READY_MS, interval: 250, label: "device ready after release --all" },
      );
      const released = await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
      expect(released.code, released.stderr).toBe(0);
      await sampling;

      const reclaimed = await eventAfter(env, "device.reclaimed", startedAt);
      expect(reclaimed, "no device.reclaimed after release --all").toBeDefined();
      const wipeStart = wipeStartOf(reclaimed as RecordedEvent);
      expect(samples.some((sample) => !sample.hasSession)).toBe(true);
      expect(samples.at(-1)?.hasSession).toBe(false);
      expect(
        samples.filter((sample) => sample.hasSession && sample.at >= wipeStart),
        "a sample saw the session after the wipe began",
      ).toEqual([]);

      ok(await open(b));
      expect((await listLeases(env))[0]?.deviceId).toBe(lease?.deviceId);
      const reopened = await b.run(["open", target.bundleId]);
      expect(reopened.code, "the fixture app survived the wipe").not.toBe(0);
      const next = await a.run(["snapshot"]);
      expect(next.code).not.toBe(0);
      expect(failureText(next)).toContain("lease ended by simlock");
    },
  );

  it(
    "a wait 20000 running when simlock release --all is called exits 0 after at least 20 s, and the wipe starts after it exits",
    { timeout: 600_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      const [lease] = await listLeases(env);
      const startedAt = Date.now();
      const running = a.start(["wait", "20000"]);
      await waitFor(
        async () =>
          (await eventAfter(env, "lease.renewed", startedAt, forLease(lease?.id))) !== undefined,
        { timeout: 60_000, interval: 500, label: "the wait's heartbeat renewed the lease" },
      );
      const releaseAt = Date.now();
      const released = await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
      expect(released.code, released.stderr).toBe(0);

      const result = await running.waitForExit(60_000);
      const exitedAt = Date.now();
      expect(result.code).toBe(0);
      expect(releaseAt, "the wait ended before release --all was called").toBeLessThan(
        exitedAt - 2_000,
      );
      expect(exitedAt - startedAt).toBeGreaterThanOrEqual(20_000);

      await waitFor(
        async () => (await eventAfter(env, "device.reclaimed", startedAt)) !== undefined,
        { timeout: 240_000, interval: 1_000, label: "device.reclaimed" },
      );
      const reclaimed = (await eventAfter(env, "device.reclaimed", startedAt)) as RecordedEvent;
      expect(wipeStartOf(reclaimed)).toBeGreaterThanOrEqual(exitedAt - 1_000);
    },
  );

  it(
    "with the only device leased, a second agent's open waits in simlock list --requests; killing its CLI empties the queue, and once the device is free no lease.granted names that request's requester while a third agent's open gets the device",
    { timeout: 900_000 },
    async () => {
      const a = await agent("a");
      const b = await agent("b");
      const c = await agent("c");
      ok(await open(a));
      const startedAt = Date.now();
      const waiting = b.start(["open", "--platform", platform]);
      let requests: RequestRow[] = [];
      await waitFor(
        async () => {
          requests = await listRequests(env);
          return requests.length === 1;
        },
        { timeout: 60_000, interval: 500, label: "b's open queued" },
      );
      const requester = requests[0]?.requesterId as string;
      waiting.kill("SIGKILL");
      await waitFor(async () => (await listRequests(env)).length === 0, {
        timeout: 60_000,
        interval: 500,
        label: "queue empty after killing b's CLI",
      });

      ok(await a.run(["close"]));
      await waitForFree(env);
      ok(await open(c));
      expect(await listLeases(env)).toHaveLength(1);
      const granted = (await env.events()).filter(
        (event) =>
          event.event === "lease.granted" &&
          event.timestamp >= startedAt &&
          (event.payload as { requester?: string }).requester === requester,
      );
      expect(granted).toEqual([]);
    },
  );

  it(
    "when the agent-device daemon is killed, a new one with a new pid runs; the agent's next command fails with lease ended by simlock, and its simlock lease is released",
    { timeout: 900_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      const old = await readPidRecord(env);
      process.kill(old.pid, "SIGKILL");
      await waitFor(
        async () => {
          const now = await readPidRecord(env);
          return now.pid !== old.pid && isAlive(now.pid);
        },
        { timeout: 60_000, interval: 500, label: "a new agent-device daemon runs" },
      );
      await awaitAgentDevice();

      const next = await a.run(["snapshot"]);
      expect(next.code).not.toBe(0);
      expect(failureText(next)).toContain("lease ended by simlock");
      await waitFor(async () => (await listLeases(env)).length === 0, {
        timeout: 60_000,
        interval: 500,
        label: "a's simlock lease released",
      });
    },
  );

  it(
    "after the simlock daemon is killed and started again, the old agent-device daemon's pid is gone within 60 s; the agent's next command fails with lease ended by simlock, and its old simlock lease is released",
    { timeout: 900_000 },
    async () => {
      const a = await agent("a");
      ok(await open(a));
      const [lease] = await listLeases(env);
      const old = await readPidRecord(env);
      onTestFinished(() => killIfStillAgentDevice(old));

      await env.killDaemon();
      await env.startDaemon();
      await awaitAgentDevice();

      await waitFor(() => !isAlive(old.pid), {
        timeout: 60_000,
        interval: 500,
        label: "the old agent-device daemon is gone",
      });
      const next = await a.run(["snapshot"]);
      expect(next.code).not.toBe(0);
      expect(failureText(next)).toContain("lease ended by simlock");
      await waitFor(async () => !(await listLeases(env)).some((row) => row.id === lease?.id), {
        timeout: 60_000,
        interval: 500,
        label: "the old lease released",
      });
    },
  );

  it(
    "with capabilities.agent-device.leaseTtlCapMs 20000, an agent that sends no more commands gets lease.expired at most 25 s after its last command, and another agent's open then gets the device",
    { timeout: 900_000 },
    async () => {
      await env.withConfig(
        { capabilities: { "agent-device": { leaseTtlCapMs: 20_000 } } },
        async () => {
          await awaitAgentDevice();
          const a = await agent("a");
          const b = await agent("b");
          ok(await open(a));
          const [lease] = await listLeases(env);
          const lastCommandAt = Date.now();

          let expired: RecordedEvent | undefined;
          await waitFor(
            async () => {
              expired = await eventAfter(
                env,
                "lease.expired",
                lastCommandAt - 5_000,
                forLease(lease?.id),
              );
              return expired !== undefined;
            },
            { timeout: 60_000, interval: 1_000, label: "lease.expired for a's lease" },
          );
          expect((expired as RecordedEvent).timestamp - lastCommandAt).toBeLessThanOrEqual(25_000);

          ok(await open(b));
          expect(await listLeases(env)).toHaveLength(1);
        },
      );
    },
  );

  it(
    "with capabilities.agent-device.leaseTtlCapMs 20000, after a graceful simlock daemon restart an old simlock lease whose agent sends nothing gets lease.expired at most 5 s after the later of its last renewal + 20 s and the moment the restarted daemon answers simlock status",
    { timeout: 900_000 },
    async () => {
      await env.withConfig(
        { capabilities: { "agent-device": { leaseTtlCapMs: 20_000 } } },
        async () => {
          await awaitAgentDevice();
          const a = await agent("a");
          ok(await open(a));
          const [lease] = await listLeases(env);

          await env.restart();
          const answeredAt = Date.now();

          let expired: RecordedEvent | undefined;
          await waitFor(
            async () => {
              expired = await eventAfter(env, "lease.expired", 0, forLease(lease?.id));
              return expired !== undefined;
            },
            { timeout: 60_000, interval: 1_000, label: "lease.expired for the old lease" },
          );
          const lastRenewal = Math.max(
            ...(await env.events())
              .filter(
                (event) =>
                  (event.event === "lease.granted" || event.event === "lease.renewed") &&
                  forLease(lease?.id)(event),
              )
              .map((event) => event.timestamp),
          );
          expect((expired as RecordedEvent).timestamp).toBeLessThanOrEqual(
            Math.max(lastRenewal + 20_000, answeredAt) + 5_000,
          );
        },
      );
    },
  );

  it(
    "with capabilities.agent-device.command pointing at an agent-device that reports 0.9.2, the daemon starts and grants a plain simlock lease --detach; an agent's open fails with agent-device is not available on this simlock: found 0.9.2, need 0.21.28 or later; simlock doctor reports module-unavailable with found 0.9.2, need 0.21.28 or later",
    { timeout: 900_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "simlock-ad-old-"));
      onTestFinished(() => rm(root, { force: true, recursive: true }));
      const entry = join(root, "bin/agent-device.mjs");
      await mkdir(dirname(entry), { recursive: true });
      await mkdir(join(root, "dist/src"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-device" }));
      await writeFile(join(root, "dist/src/daemon.js"), "");
      await writeFile(entry, '#!/usr/bin/env node\nconsole.log("0.9.2");\n');
      await chmod(entry, 0o755);
      const message = "found 0.9.2, need 0.21.28 or later";

      await env.withConfig({ capabilities: { "agent-device": { command: entry } } }, async () => {
        const a = await agent("a");
        let finding: { kind: string; message: string } | undefined;
        await waitFor(
          async () => {
            const doctor = await env.cli(["doctor"], { timeout: 60_000 });
            finding = (
              doctor.json as { findings: { kind: string; message: string }[] }
            ).findings.find((row) => row.kind === "module-unavailable");
            return finding !== undefined;
          },
          { timeout: 60_000, interval: 500, label: "doctor reports module-unavailable" },
        );
        expect(finding?.message).toContain(message);

        const plain = await env.cli(
          ["lease", "--detach", "--platform", platform, "--agent-id", "plain"],
          { timeout: 330_000 },
        );
        expect(plain.code, plain.stderr).toBe(0);
        const released = await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
        expect(released.code, released.stderr).toBe(0);
        await waitForFree(env);

        const opened = await tryOpen(a);
        expect(opened.code).not.toBe(0);
        expect(failureText(opened)).toContain(
          `agent-device is not available on this simlock: ${message}`,
        );
      });
    },
  );

  describe("with the device limit raised to 2", () => {
    beforeAll(async () => {
      await setLimits(env, target, 2);
      await awaitAgentDevice();
      await warmUp(env, target, 2);
    }, 420_000);

    afterAll(async () => {
      await setLimits(env, target, 1);
      await awaitAgentDevice();
    }, 600_000);

    it(
      "with both devices ready, devices lists nothing before open, and after open only the device it bound, not the other ready device",
      { timeout: 600_000 },
      async () => {
        const a = await agent("a");
        expect((await listDevices(env)).filter((device) => device.state === "ready")).toHaveLength(
          2,
        );
        const before = await a.run(["devices"]);
        ok(before);
        expect(listField(before, "devices")).toEqual([]);

        ok(await open(a));
        const [lease] = await listLeases(env);
        const bound = (await listDevices(env)).find((device) => device.id === lease?.deviceId);
        const after = await a.run(["devices"]);
        ok(after);
        expect(listField(after, "devices").map((device) => (device as { id: string }).id)).toEqual([
          bound?.address,
        ]);
      },
    );

    it(
      "two agents on two tokens get two different devices; B's snapshot naming its own device is accepted and naming A's is refused; after B's close, A's snapshot still works",
      { timeout: 900_000 },
      async () => {
        const a = await agent("a");
        const b = await agent("b");
        ok(await open(a));
        ok(await open(b));
        // why: an iOS snapshot needs an app session on the device (ios_app_session_required).
        for (const who of [a, b]) {
          ok(await who.run(["install", "Appduct", target.app]));
          ok(await who.run(["open", target.bundleId]));
        }
        const leases = await listLeases(env);
        expect(new Set(leases.map((lease) => lease.deviceId)).size).toBe(2);
        const devices = await listDevices(env);
        const addressOf = (who: Agent): string => {
          // why: a lease's requesterId is the lease's own ID when the agent chose it; the token is its ownerId.
          const lease = leases.find((row) => row.ownerId === who.tokenId);
          const address = devices.find((device) => device.id === lease?.deviceId)?.address;
          if (address === undefined)
            throw new Error(`no leased device found for agent ${who.name}`);
          return address;
        };

        ok(await b.run(["snapshot", target.deviceFlag, addressOf(b)], FIRST_SNAPSHOT));
        refused(await b.run(["snapshot", target.deviceFlag, addressOf(a)]));
        ok(await b.run(["close"]));
        ok(await a.run(["snapshot"], FIRST_SNAPSHOT));
      },
    );

    it(
      "with both devices booted, agent A holding one and agent B the other: A's test <suite> --shard-all 1 with no --device passes, and A's test <suite> --shard-all 2 with no --device fails with test sharding requires 2 devices, but only 1 matched",
      { timeout: 900_000 },
      async () => {
        const a = await agent("a");
        const b = await agent("b");
        ok(await open(a));
        ok(await open(b));
        const suite = await mkdtemp(join(tmpdir(), "simlock-ad-suite-"));
        onTestFinished(() => rm(suite, { force: true, recursive: true }));
        // why: a script needs a `context platform=` line (agent-device refuses one without), and a step that needs no app session: the shard runs beside agent A's open session, so `open` fails with the device in use and a `snapshot` with no app session.
        await writeFile(join(suite, "smoke.ad"), `context platform=${platform}\nwait 200\n`);

        ok(await a.run(["test", suite, "--shard-all", "1"]));
        const two = await a.run(["test", suite, "--shard-all", "2"]);
        expect(two.code).not.toBe(0);
        expect(failureText(two)).toContain("test sharding requires 2 devices, but only 1 matched");
      },
    );
  });
}

describe.skipIf(AGENT_DEVICE === undefined || !iosAvailable)(
  "agent-device through simlock (iOS)",
  { tags: ["slow", "ios"] },
  () => defineSuite(IOS),
);

// why: under `deviceSet: "default"` Simlock keeps its simulators in Xcode's own set, so plain `xcrun simctl` (no `--set`) must see the leased one; a daemon with a home of its own makes this a second daemon, not the shared one above.
describe.skipIf(AGENT_DEVICE === undefined || !iosAvailable)(
  "agent-device through simlock (iOS, drivers.ios.deviceSet default)",
  { tags: ["slow", "ios"] },
  () => {
    let env: SharedTestEnv;

    beforeAll(async () => {
      const pinned = await assertPinnedAgentDevice("ios");
      env = await withSharedDaemon({
        driver: "real",
        configOverrides: {
          http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
          capabilities: { "agent-device": { enabled: true, command: pinned } },
          capacity: { config: { limits: { ios: { maxDevices: 1, maxRunning: 1 } } } },
          drivers: { ios: { deviceSet: "default" } },
        },
      });
      sharedEnvs.add(env);
      const probe = await newAgentToken(env);
      await waitForAgentDevice(env, probe.secret);
    }, 420_000);

    afterAll(async () => {
      await cleanupAgents();
      // why: the simulators are in the maintainer's Xcode set, which the home's removal does not clean.
      if (env !== undefined) {
        await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
        await env.cli(["nuke", "--delete-devices", "--yes"], { timeout: 300_000 });
      }
      await env?.teardown();
      sharedEnvs.delete(env);
    }, 420_000);

    it(
      "under a daemon with drivers.ios.deviceSet default, an agent opens an iOS device, plain xcrun simctl list devices lists its UDID, and snapshot answers",
      { timeout: 900_000 },
      async () => {
        const a = await makeAgent(env, "default-set");
        const opened = await a.run(["open", "--platform", "ios"], { timeout: 330_000 });
        ok(opened);
        const [lease] = await listLeases(env);
        const udid = (await listDevices(env)).find(
          (device) => device.id === lease?.deviceId,
        )?.address;
        expect(udid, "the leased device's address").toBeDefined();
        expect(
          execFileSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8" }),
        ).toContain(udid as string);
        ok(await a.run(["install", "Appduct", IOS.app]));
        ok(await a.run(["open", IOS.bundleId]));
        ok(await a.run(["snapshot"], FIRST_SNAPSHOT));
        ok(await a.run(["close"]));
      },
    );
  },
);

describe.skipIf(AGENT_DEVICE === undefined || !androidAvailable)(
  "agent-device through simlock (Android)",
  { tags: ["slow", "android"] },
  () => defineSuite(ANDROID),
);
