import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { AdbServerSupervisor, AdbServerUnavailableError } from "./adb-server.js";

const adb = "/android-sdk/platform-tools/adb";
const home = "/home/simlock/.simlock";
const recordPath = `${home}/adb-server.json`;
const port = 5038;
const recordedPid = 4242;

describe("AdbServerSupervisor.start", () => {
  it("adopts the server a previous daemon left listening on its own recorded pid", async () => {
    const harness = await start({
      listening: true,
      livePids: [recordedPid],
      record: { pid: recordedPid, port, startedAt: 17 },
    });

    await harness.started;

    expect(harness.runner.calls).toEqual([]);
    expect(harness.supervisor.signals).toEqual([]);
    // Untouched, `startedAt` included: rewriting it would erase the only hint that a pid
    // was recycled under a record Simlock is about to trust.
    await expect(harness.filesystem.readFile(recordPath)).resolves.toContain('"startedAt":17');
  });

  it("refuses a port something else is already listening on", async () => {
    const harness = await start({ listening: true });

    await expect(harness.started).rejects.toMatchObject({
      name: "AdbServerUnavailableError",
      port,
      reason: "occupied",
    });
  });

  it("refuses a port whose recorded server is dead even though something answers there", async () => {
    // The listener cannot be Simlock's -- the pid that would prove it is gone -- so this is
    // somebody else's adb server, and attaching to it is what failing closed prevents.
    const harness = await start({
      listening: true,
      record: { pid: recordedPid, port, startedAt: 1 },
    });

    await expect(harness.started).rejects.toMatchObject({ reason: "occupied" });
  });

  it.each([
    ["the shared adb server's port", 5037],
    ["a privileged port", 80],
    ["a port outside the addressable range", 70_000],
    ["a port that is not a whole number", 5038.5],
  ])("refuses %s before probing it", async (_case, configured) => {
    const probe = new FakeTcpProbe();
    const isListening = vi.spyOn(probe, "isListening");
    const harness = await start({ port: configured, probe });

    await expect(harness.started).rejects.toMatchObject({
      port: configured,
      reason: "invalid-port",
    });
    // A probe answers `false` for a port nothing could listen on, which would read as
    // "free" and hand an impossible port to a spawn that cannot work.
    expect(isListening).not.toHaveBeenCalled();
  });

  it("starts a scoped, foregrounded server and records the pid that is the server", async () => {
    const harness = await start({ expectations: [serverSpawn()], spawnStartsListening: true });

    await harness.started;

    expect(harness.runner.calls).toEqual([
      {
        args: ["-P", "5038", "nodaemon", "server"],
        command: adb,
        options: {
          env: {
            ADB_EMU: "0",
            ADB_LOCAL_TRANSPORT_MAX_PORT: "5683",
            ADB_MDNS: "0",
            ADB_REJECT_KILL_SERVER: "1",
            ADB_USB: "0",
            ANDROID_ADB_SERVER_PORT: "5038",
            ANDROID_HOME: "/android-sdk",
            PATH: "/usr/bin",
          },
          stdio: "ignore",
        },
      },
    ]);
    await expect(harness.filesystem.readFile(recordPath)).resolves.toContain('"pid": 1');
  });

  it("kills the child and refuses when the server it started never listens", async () => {
    const harness = await start({ expectations: [serverSpawn()] });

    await expect(advancing(harness.clock, harness.started)).rejects.toMatchObject({
      reason: "start-failed",
    });
    expect(harness.kills).toEqual(["SIGKILL"]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("reaps a recorded adb process that is alive but serving nothing, then starts its own", async () => {
    const harness = await start({
      expectations: [
        processIdentity(recordedPid, "/android-sdk/platform-tools/adb"),
        serverSpawn(),
      ],
      livePids: [recordedPid],
      record: { pid: recordedPid, port, startedAt: 1 },
      spawnStartsListening: true,
    });
    harness.supervisor.onSignal = (pid) => harness.supervisor.markDead(pid);

    await harness.started;

    expect(harness.supervisor.signals).toEqual([{ pid: recordedPid, signal: "SIGTERM" }]);
  });

  it("escalates to SIGKILL when a recorded server ignores SIGTERM", async () => {
    const harness = await start({
      expectations: [
        processIdentity(recordedPid, "adb"),
        processIdentity(recordedPid, "adb"),
        serverSpawn(),
      ],
      livePids: [recordedPid],
      record: { pid: recordedPid, port, startedAt: 1 },
      spawnStartsListening: true,
    });
    // Dies only on the second signal, which is the case the escalation exists for.
    harness.supervisor.onSignal = (pid, signal) => {
      if (signal === "SIGKILL") harness.supervisor.markDead(pid);
    };

    await advancing(harness.clock, harness.started);

    expect(harness.supervisor.signals).toEqual([
      { pid: recordedPid, signal: "SIGTERM" },
      { pid: recordedPid, signal: "SIGKILL" },
    ]);
  });

  it("never signals a recorded pid that is no longer an adb process", async () => {
    // The recycled-pid case: the number is alive, but it belongs to a stranger now, and a
    // record is not a licence to kill whatever answers to its pid.
    const harness = await start({
      expectations: [processIdentity(recordedPid, "/usr/bin/vim"), serverSpawn()],
      livePids: [recordedPid],
      record: { pid: recordedPid, port, startedAt: 1 },
      spawnStartsListening: true,
    });

    await harness.started;

    expect(harness.supervisor.signals).toEqual([]);
  });

  it.each([
    ["is unreadable", undefined],
    ["is not JSON", "not json"],
    ["carries no usable pid", JSON.stringify({ pid: 0, port, startedAt: 1 })],
    ["names another port", JSON.stringify({ pid: recordedPid, port: 5999, startedAt: 1 })],
  ])("treats a record that %s as no server at all", async (_case, contents) => {
    const harness = await start({
      expectations: [serverSpawn()],
      livePids: [recordedPid],
      ...(contents === undefined ? {} : { rawRecord: contents }),
      spawnStartsListening: true,
    });

    await harness.started;

    // Straight to the spawn: no identity read, no signal, nothing to adopt.
    expect(harness.supervisor.signals).toEqual([]);
    expect(harness.runner.calls).toHaveLength(1);
  });
});

describe("AdbServerSupervisor.stop", () => {
  it("stops the server it started by pid and drops the record", async () => {
    const harness = await start({
      expectations: [serverSpawn(), processIdentity(1, "adb")],
      spawnStartsListening: true,
    });
    await harness.started;
    // The spawned server is the pid the record now names, and only a live one can be stopped.
    harness.supervisor.markAlive(1);
    harness.supervisor.onSignal = (pid) => harness.supervisor.markDead(pid);

    await harness.adbServer.stop();

    expect(harness.supervisor.signals).toEqual([{ pid: 1, signal: "SIGTERM" }]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("does nothing when no server was ever established", async () => {
    const harness = await start({ listening: true });
    await expect(harness.started).rejects.toBeInstanceOf(AdbServerUnavailableError);

    await harness.adbServer.stop();

    expect(harness.supervisor.signals).toEqual([]);
  });
});

interface StartOptions {
  readonly expectations?: readonly ScriptedProcessExpectation[];
  readonly listening?: boolean;
  readonly livePids?: readonly number[];
  readonly port?: number;
  readonly probe?: FakeTcpProbe;
  readonly rawRecord?: string;
  readonly record?: { readonly pid: number; readonly port: number; readonly startedAt: number };
  readonly spawnStartsListening?: boolean;
}

/**
 * Builds a supervisor and calls `start()` without awaiting it, so a test can drive the
 * clock and the signals while the call is still in flight.
 */
async function start(options: StartOptions = {}) {
  const configuredPort = options.port ?? port;
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(home);
  const contents =
    options.rawRecord ??
    (options.record === undefined ? undefined : JSON.stringify(options.record));
  if (contents !== undefined) {
    await filesystem.writeFileAtomic(recordPath, contents);
  }

  const clock = new FakeClock();
  const probe =
    options.probe ?? new FakeTcpProbe(options.listening === true ? [configuredPort] : []);
  const runner = new ScriptedProcessRunner(options.expectations ?? []);
  const supervisor = new SignallingSupervisor(options.livePids ?? []);
  const kills: NodeJS.Signals[] = [];
  const spawn = runner.spawn.bind(runner);
  vi.spyOn(runner, "spawn").mockImplementation((command, args, spawnOptions) => {
    const handle = spawn(command, args, spawnOptions);
    if (options.spawnStartsListening === true) {
      probe.startListening(configuredPort);
    }
    return {
      pid: handle.pid,
      stderr: handle.stderr,
      stdout: handle.stdout,
      kill(signal) {
        kills.push(signal ?? "SIGTERM");
        handle.kill(signal);
      },
      wait: () => handle.wait(),
    };
  });

  const adbServer = new AdbServerSupervisor({
    adbPath: adb,
    clock,
    env: { ANDROID_HOME: "/android-sdk", PATH: "/usr/bin" },
    filesystem,
    port: configuredPort,
    processRunner: runner,
    processSupervisor: supervisor,
    recordPath,
    tcpProbe: probe,
  });
  const started = adbServer.start();
  // Nothing awaits a refusal until the test does, and an unobserved rejection in the
  // meantime is noise vitest reports as a failure.
  started.catch(() => undefined);

  return { adbServer, clock, filesystem, kills, probe, runner, started, supervisor };
}

function serverSpawn(): ScriptedProcessExpectation {
  return { hangs: true, match: { args: ["-P", "5038", "nodaemon", "server"], command: adb } };
}

/** The `ps` read that proves a recorded pid really is an adb server before it is signalled. */
function processIdentity(pid: number, command: string): ScriptedProcessExpectation {
  return {
    match: { args: ["-o", "comm=", "-p", String(pid)], command: "ps" },
    result: { code: 0, stderr: "", stdout: `${command}\n` },
  };
}

/** A `FakeProcessSupervisor` whose test decides what a signal does to the process. */
class SignallingSupervisor extends FakeProcessSupervisor {
  onSignal: ((pid: number, signal: NodeJS.Signals) => void) | undefined;

  override signal(pid: number, signal: NodeJS.Signals): void {
    super.signal(pid, signal);
    this.onSignal?.(pid, signal);
  }
}

/**
 * Drives a fake clock forward until the work settles. The supervisor's waits are timer
 * loops, so each iteration schedules its next timer only after the previous one fires --
 * a single `advance` would run one iteration and stop.
 */
async function advancing<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);

  for (let tick = 0; tick < 1_000 && !settled; tick += 1) {
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(100);
  }

  return tracked;
}
