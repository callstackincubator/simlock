import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../../ports/index.js";
import {
  stateDir,
  recordPath,
  daemonJsonPath,
  nodePath,
  packageRoot,
  internalEntry,
  httpPort,
  token,
  Options,
  arrange,
  Harness,
  run,
  versionRun,
  daemonSpawn,
  ownLine,
  record,
  flush,
  advanceBy,
  advancing,
  advanceUntil,
  stateOf,
  unavailable,
  running,
  commandsRun,
  daemonSpawns,
  warnings,
  readJson,
} from "./test-agent-device-supervisor.js";

describe("AgentDeviceSupervisor reaping a daemon a killed simlock left", () => {
  const recorded = { livePids: [900], record: record(900) };

  it("sends SIGTERM to a live recorded pid whose line ends with the marker and holds the entry, removes the record once it is gone, and starts a new daemon", async () => {
    const harness = await run({
      ...recorded,
      commandLines: [[900, [ownLine()]]],
    });

    expect(harness.processes.signals).toEqual([{ pid: 900, signal: "SIGTERM" }]);
    expect(harness.processes.isAlive(900)).toBe(false);
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: harness.children[0]?.pid });
    expect(stateOf(harness)).toBe("running");
  });

  it("escalates to SIGKILL after 10 s when the recorded pid ignores SIGTERM and is still identified", async () => {
    const harness = await arrange({
      ...recorded,
      behaviours: new Map([[900, "ignores-sigterm"]]),
      commandLines: [[900, [ownLine(), ownLine()]]],
    });
    const startedAt = harness.clock.now();

    await advancing(harness, harness.begin());

    expect(harness.processes.signals).toEqual([
      { pid: 900, signal: "SIGTERM" },
      { pid: 900, signal: "SIGKILL" },
    ]);
    expect(harness.clock.now() - startedAt).toBeGreaterThanOrEqual(10_000);
    expect(stateOf(harness)).toBe("running");
  });

  it("sends no SIGKILL to a pid whose second command line no longer passes the identity check", async () => {
    const harness = await run({
      ...recorded,
      behaviours: new Map([[900, "ignores-sigterm"]]),
      commandLines: [[900, [ownLine(), "/usr/bin/vim notes.txt"]]],
    });

    expect(harness.processes.signals).toEqual([{ pid: 900, signal: "SIGTERM" }]);
  });

  it("keeps the record and reports start-failed naming the pid when it is still alive 2 s after SIGKILL", async () => {
    const harness = await run({
      ...recorded,
      behaviours: new Map([[900, "immortal"]]),
      commandLines: [[900, [ownLine(), ownLine()]]],
      expectations: [],
    });

    expect(harness.processes.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("900");
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: 900 });
    expect(daemonSpawns(harness)).toEqual([]);
  });

  it("spawns with the resolved home as the marker when SIMLOCK_HOME is reached through a symlink, and a later start reaps that child", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/private/tmp/x");
    await filesystem.mkdirp("/tmp");
    filesystem.defineSymlink("/tmp/x", "/private/tmp/x");
    const first = await run({
      expectations: [versionRun(), daemonSpawn(internalEntry, {}, "/private/tmp/x")],
      filesystem,
      home: "/tmp/x",
    });
    const childPid = first.children[0]?.pid as number;
    expect(first.children[0]?.args).toEqual([internalEntry, "--simlock-home=/private/tmp/x"]);

    const second = await run({
      commandLines: [[childPid, [ownLine(internalEntry, "/private/tmp/x")]]],
      expectations: [versionRun(), daemonSpawn(internalEntry, {}, "/private/tmp/x")],
      filesystem,
      home: "/tmp/x",
      livePids: [childPid],
    });

    expect(second.processes.signals).toEqual([{ pid: childPid, signal: "SIGTERM" }]);
  });

  it("reaps the live pid daemon.json names when there is no record and the line ends with the marker", async () => {
    const harness = await run({
      commandLines: [[901, [ownLine()]]],
      livePids: [901],
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(
          daemonJsonPath,
          JSON.stringify({ httpPort, pid: 901, token }),
        );
      },
    });

    expect(harness.processes.signals).toEqual([{ pid: 901, signal: "SIGTERM" }]);
  });

  it("does not read daemon.json and signals nothing when the state directory is a symlink", async () => {
    const harness = await run({
      expectations: [versionRun()],
      livePids: [901],
      stateDirContents: async (filesystem) => {
        await filesystem.mkdirp("/elsewhere");
        await filesystem.writeFileAtomic("/elsewhere/daemon.json", JSON.stringify({ pid: 901 }));
        filesystem.defineSymlink(stateDir, "/elsewhere");
      },
    });

    expect(harness.processes.signals).toEqual([]);
    expect(harness.processes.commandLineReads).toEqual([]);
    expect(unavailable(harness).reason).toBe("state-dir");
  });

  it.each([
    ["a dead recorded pid", [], undefined],
    ["a command line of another command", [900], "/usr/bin/vim notes.txt"],
    ["a line holding the entry but no marker", [900], `${nodePath} ${internalEntry}`],
    ["a line with another home's marker", [900], ownLine(internalEntry, "/other/home")],
    [
      "a line with this home's marker but another entry than the recorded one",
      [900],
      ownLine("/elsewhere/daemon.js"),
    ],
  ] as const)("removes the record and signals nothing for %s", async (_case, livePids, line) => {
    // why: the spawn throws, so no new record can stand in for the old one: only a removal empties it.
    const harness = await run({
      commandLines: line === undefined ? [] : [[900, [line]]],
      livePids,
      record: record(900),
      spawnThrows: new Error("no spawn"),
    });

    expect(harness.processes.signals).toEqual([]);
    expect(await harness.filesystem.exists(recordPath)).toBe(false);
  });

  it("signals nothing when daemon.json names another pid than the recorded one", async () => {
    const harness = await run({
      commandLines: [[900, [ownLine()]]],
      livePids: [900],
      record: record(900),
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(daemonJsonPath, JSON.stringify({ pid: 777 }));
      },
    });

    expect(harness.processes.signals).toEqual([]);
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: harness.children[0]?.pid });
    expect(stateOf(harness)).toBe("running");
  });

  it("removes the record when daemon.json names another pid than the recorded one", async () => {
    const harness = await run({
      commandLines: [[900, [ownLine()]]],
      livePids: [900],
      record: record(900),
      spawnThrows: new Error("no spawn"),
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        await filesystem.writeFileAtomic(daemonJsonPath, JSON.stringify({ pid: 777 }));
      },
    });

    expect(await harness.filesystem.exists(recordPath)).toBe(false);
  });

  it("signals nothing, keeps the record, starts nothing and reports start-failed naming the pid when its command line cannot be read", async () => {
    const harness = await run({
      commandLines: [[900, [undefined]]],
      livePids: [900],
      record: record(900),
    });

    expect(harness.processes.commandLineReads).toEqual([900]);
    expect(harness.processes.signals).toEqual([]);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("900");
    expect(await readJson(harness, recordPath)).toMatchObject({ pid: 900 });
    expect(commandsRun(harness).filter((call) => call[0] === nodePath)).toEqual([]);
  });
});

describe("AgentDeviceSupervisor after the daemon is running", () => {
  async function runningFor(
    options: Options,
    ms: number,
  ): Promise<{ harness: Harness; readyAt: number }> {
    const harness = await run(options);
    expect(stateOf(harness)).toBe("running");
    const readyAt = harness.clock.now();
    await advanceBy(harness, ms);
    return { harness, readyAt };
  }

  it("starts a child that exited 60 s after ready again at once with the same environment, as generation 2, and warns with the exit code", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      60_000,
    );
    const firstEnv = harness.runner.calls[1]?.options.env;

    harness.children[0]?.exit(42);
    await flush();
    expect(stateOf(harness)).toBe("starting");
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);

    expect(daemonSpawns(harness)).toHaveLength(2);
    expect(harness.runner.calls[3]?.options.env).toEqual(firstEnv);
    expect(running(harness).generation).toBe(2);
    expect(
      warnings(harness).some(
        (line) => line.includes("agent-device (simulators) daemon pid") && line.includes("42"),
      ),
    ).toBe(true);
  });

  it("reports start-failed for a child that exits 5 s after ready, and starts it again only 30 s later", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      5_000,
    );

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toMatch(
      /agent-device exited .*9.* 5 s after it was ready/,
    );
    await advanceBy(harness, 29_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);
    expect(daemonSpawns(harness)).toHaveLength(2);
  });

  it("times the stable uptime from ready, not from the spawn: a child ready 10 s after the spawn that exits 62 s after it is start-failed", async () => {
    const harness = await arrange({
      daemonJson: () => "none",
      expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()],
    });
    void harness.begin();
    await advanceUntil(harness, () => harness.children.length === 1, 5_000);
    const spawnedAt = harness.clock.now();
    await advanceBy(harness, 10_000);
    await harness.filesystem.writeFileAtomic(
      daemonJsonPath,
      JSON.stringify({ httpPort, pid: harness.children[0]?.pid, token }),
    );
    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);
    await advanceBy(harness, spawnedAt + 62_000 - harness.clock.now());

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(daemonSpawns(harness)).toHaveLength(1);
  });

  it("reports start-failed for a child that exits 59 s after ready instead of starting it at once", async () => {
    const { harness } = await runningFor(
      { expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()] },
      59_000,
    );

    harness.children[0]?.exit(9);
    await flush();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(daemonSpawns(harness)).toHaveLength(1);
  });

  it("retries a failed first start 30 s later and is running when that succeeds", async () => {
    const harness = await arrange({
      daemonJson: (index) => (index === 0 ? "none" : "ready"),
      expectations: [versionRun(), daemonSpawn(), versionRun(), daemonSpawn()],
    });
    await advancing(harness, harness.begin());
    expect(unavailable(harness).reason).toBe("start-failed");
    const failedAt = harness.clock.now();

    await advanceBy(harness, 29_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);

    expect(daemonSpawns(harness)).toHaveLength(2);
    expect(harness.clock.now() - failedAt).toBeGreaterThanOrEqual(30_000);
    expect(harness.clock.now() - failedAt).toBeLessThanOrEqual(30_500);
    expect(running(harness).generation).toBe(1);
  });

  it("retries a start that failed after a restart 30 s later", async () => {
    const harness = await arrange({
      daemonJson: (index) => (index === 1 ? "none" : "ready"),
      expectations: [
        versionRun(),
        daemonSpawn(),
        versionRun(),
        daemonSpawn(),
        versionRun(),
        daemonSpawn(),
      ],
    });
    await advancing(harness, harness.begin());
    await advanceBy(harness, 60_000);
    harness.children[0]?.exit(1);
    await advanceUntil(harness, () => unavailableState(harness), 30_000);
    expect(unavailable(harness).reason).toBe("start-failed");

    await advanceUntil(harness, () => stateOf(harness) === "running", 60_000);

    expect(daemonSpawns(harness)).toHaveLength(3);
    expect(stateOf(harness)).toBe("running");
  });

  function unavailableState(harness: Harness): boolean {
    return stateOf(harness) === "unavailable";
  }

  it.each([
    ["not-found", { baseEnvironment: { PATH: "/nowhere" }, expectations: [] }],
    [
      "not-agent-device",
      {
        expectations: [versionRun()],
        layout: async (filesystem: MemoryFilesystem) =>
          filesystem.rm(`${packageRoot}/package.json`),
      },
    ],
    ["wrong-version", { expectations: [versionRun("0.20.3\n")] }],
    [
      "state-dir",
      {
        expectations: [versionRun()],
        stateDirContents: async (filesystem: MemoryFilesystem) => {
          await filesystem.mkdirp("/elsewhere");
          filesystem.defineSymlink(stateDir, "/elsewhere");
        },
      },
    ],
  ] satisfies [string, Options][])("does not retry a %s", async (reason, options) => {
    const harness = await run(options);
    expect(unavailable(harness).reason).toBe(reason);
    const calls = harness.runner.calls.length;

    await advanceBy(harness, 120_000);

    expect(harness.runner.calls).toHaveLength(calls);
    expect(unavailable(harness).reason).toBe(reason);
  });
});

describe("AgentDeviceSupervisor.stop", () => {
  it("sends SIGTERM to the child, removes the record once it is gone, starts nothing more and leaves availability off", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid;
    const calls = harness.runner.calls.length;

    await advancing(harness, harness.agentDevice.stop());

    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
    expect(harness.events.slice(-1)).toEqual([`exit ${pid}`]);
    await advanceBy(harness, 120_000);
    expect(harness.runner.calls).toHaveLength(calls);
    expect(stateOf(harness)).toBe("off");
  });

  it("sends SIGKILL after 10 s when the child ignores SIGTERM", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "ignores-sigterm");
    const stoppedAt = harness.clock.now();

    await advancing(harness, harness.agentDevice.stop());

    expect(harness.processes.signals).toEqual([
      { pid, signal: "SIGTERM" },
      { pid, signal: "SIGKILL" },
    ]);
    expect(harness.clock.now() - stoppedAt).toBeGreaterThanOrEqual(10_000);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("keeps the record and warns naming the pid when the child is alive 2 s after SIGKILL, and availability still ends off", async () => {
    const harness = await run();
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.agentDevice.stop());

    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
    expect(
      warnings(harness).some((line) =>
        line.includes(`agent-device (simulators) daemon pid ${pid} is still alive after`),
      ),
    ).toBe(true);
    expect(stateOf(harness)).toBe("off");
  });

  it("warns naming the pid and keeps the record when stop() ends a start whose child survives SIGKILL", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.agentDevice.stop());
    await advancing(harness, harness.started as Promise<void>);

    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
    expect(
      warnings(harness).some((line) =>
        line.includes(`agent-device (simulators) daemon pid ${pid} is still alive after`),
      ),
    ).toBe(true);
    expect(stateOf(harness)).toBe("off");
  });

  it("spawns nothing when stop() is asked while the state directory is being prepared", async () => {
    const harness = await arrange();
    const writeFileAtomic = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    let stopping: Promise<void> | undefined;
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, data) => {
      if (path === `${stateDir}/policy.json`) stopping = harness.agentDevice.stop();
      await writeFileAtomic(path, data);
    });

    await advancing(harness, harness.begin());
    await advancing(harness, stopping as Promise<void>);

    expect(daemonSpawns(harness)).toHaveLength(0);
    expect(stateOf(harness)).toBe("off");
  });

  it("cancels a pending retry", async () => {
    const harness = await run({ daemonJson: () => "none" });
    expect(unavailable(harness).reason).toBe("start-failed");
    const calls = harness.runner.calls.length;

    await advancing(harness, harness.agentDevice.stop());
    await advanceBy(harness, 120_000);

    expect(harness.runner.calls).toHaveLength(calls);
    expect(stateOf(harness)).toBe("off");
  });

  it("ends a start in progress with the child killed and availability off", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);
    const pid = harness.children[0]?.pid;

    await advancing(harness, harness.agentDevice.stop());
    await advancing(harness, harness.started as Promise<void>);

    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(stateOf(harness)).toBe("off");
    await advanceBy(harness, 120_000);
    expect(daemonSpawns(harness)).toHaveLength(1);
    expect(stateOf(harness)).toBe("off");
  });

  it("leaves no unhandled rejection when a health read rejects after stop() was asked during the port check", async () => {
    const harness = await arrange();
    harness.health.rejectWith(new Error("ECONNREFUSED"));
    const isListening = harness.probe.isListening.bind(harness.probe);
    let stopping: Promise<void> | undefined;
    vi.spyOn(harness.probe, "isListening").mockImplementation(async (port) => {
      stopping = harness.agentDevice.stop();
      return isListening(port);
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      harness.begin();
      await advanceBy(harness, 5_000);
      await advancing(harness, stopping as Promise<void>);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
    expect(stateOf(harness)).toBe("off");
  });
});
