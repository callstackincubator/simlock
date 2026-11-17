import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../../ports/index.js";
import {
  home,
  stateDir,
  recordPath,
  policyPath,
  daemonJsonPath,
  internalEntry,
  httpPort,
  token,
  healthyBody,
  restartCommand,
  stemOf,
  arrange,
  run,
  versionRun,
  daemonSpawn,
  phoneSpawn,
  advanceBy,
  advancing,
  advanceUntil,
  stateOf,
  unavailable,
  daemonSpawns,
  warnings,
  readJson,
} from "./test-agent-device-supervisor.js";

describe("AgentDeviceSupervisor state directory", () => {
  it("creates a missing state directory with mode 0700", async () => {
    const harness = await run();

    await expect(harness.filesystem.lstat(stateDir)).resolves.toMatchObject({
      kind: "directory",
      mode: 0o700,
    });
  });

  it("sets an existing state directory to mode 0700", async () => {
    const harness = await run({
      stateDirContents: async (filesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o755 });
      },
    });

    await expect(harness.filesystem.lstat(stateDir)).resolves.toMatchObject({ mode: 0o700 });
    expect(stateOf(harness)).toBe("running");
  });

  it.each([
    ["simulators" as const, [versionRun(), daemonSpawn()]],
    ["phones" as const, [versionRun(), phoneSpawn()]],
  ])(
    "a daemon start empties the %s daemon's sessions folder and leaves the rest of its state directory",
    async (role, expectations) => {
      const sessions = `${home}/${stemOf(role)}/sessions`;
      const harness = await run({
        expectations,
        role,
        stateDirContents: async (filesystem) => {
          await filesystem.mkdirp(`${sessions}/adc-1`);
          await filesystem.writeFileAtomic(`${sessions}/adc-1/events.ndjson`, "{}\n");
          await filesystem.mkdirp(`${sessions}/tok_one_my-session`);
        },
      });

      expect(stateOf(harness)).toBe("running");
      expect(await harness.filesystem.readdir(sessions)).toEqual([]);
      expect(await harness.filesystem.exists(`${home}/${stemOf(role)}/policy.json`)).toBe(true);
    },
  );

  it.each([
    [
      "a symlink",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdirp("/elsewhere");
        filesystem.defineSymlink(stateDir, "/elsewhere");
      },
    ],
    [
      "a file",
      async (filesystem: MemoryFilesystem) =>
        filesystem.writeFileAtomic(stateDir, "not a directory"),
    ],
    [
      "a directory owned by another user",
      async (filesystem: MemoryFilesystem) => {
        await filesystem.mkdir(stateDir, { mode: 0o700 });
        filesystem.defineAttributes(stateDir, { uid: (process.getuid?.() ?? 0) + 1 });
      },
    ],
  ])(
    "treats %s as the state directory as state-dir, naming the path, and spawns nothing",
    async (_case, stateDirContents) => {
      const harness = await run({ expectations: [versionRun()], stateDirContents });

      expect(unavailable(harness).reason).toBe("state-dir");
      expect(unavailable(harness).message).toContain(stateDir);
      expect(unavailable(harness).remedy).toContain(stateDir);
      for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
      expect(daemonSpawns(harness)).toEqual([]);
    },
  );

  it("treats a chmod that throws on an existing state directory as state-dir naming the path and the cause", async () => {
    const filesystem = new MemoryFilesystem();
    vi.spyOn(filesystem, "chmod").mockRejectedValue(new Error("EPERM: operation not permitted"));
    const harness = await run({
      expectations: [versionRun()],
      filesystem,
      stateDirContents: async (memory) => {
        await memory.mkdir(stateDir, { mode: 0o755 });
      },
    });

    expect(unavailable(harness).reason).toBe("state-dir");
    expect(unavailable(harness).message).toContain(stateDir);
    expect(unavailable(harness).message).toContain("EPERM");
    expect(daemonSpawns(harness)).toEqual([]);
  });
});

describe("AgentDeviceSupervisor pid record", () => {
  it("records the child's pid and entry while daemon.json is not yet written", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);

    expect(await readJson(harness, recordPath)).toMatchObject({
      entry: internalEntry,
      pid: harness.children[0]?.pid,
    });
    expect(typeof (await readJson(harness, recordPath))["startedAt"]).toBe("number");
  });

  it("kills the child and reports start-failed naming the error when the record write throws", async () => {
    const harness = await arrange();
    const write = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, ...rest) => {
      if (path === recordPath) throw new Error("ENOSPC: no space left");
      return write(path, ...rest);
    });

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("ENOSPC");
    expect(harness.processes.signals).toEqual([
      { pid: harness.children[0]?.pid, signal: "SIGTERM" },
    ]);
  });
});

describe("AgentDeviceSupervisor readiness", () => {
  it("is running with the version, base URL, token and generation 1 once daemon.json names the child, the port listens and /health answers protocol 2", async () => {
    const harness = await run();

    expect(harness.availability()).toEqual({
      baseUrl: `http://127.0.0.1:${httpPort}`,
      generation: 1,
      leaseMaxTtlMs: 24 * 60 * 60_000,
      platforms: ["ios", "android"],
      state: "running",
      token,
      version: "0.21.28",
    });
    expect(harness.health.reads).toContain(`http://127.0.0.1:${httpPort}`);
  });

  it("is not ready while daemon.json names another pid, and ready once it names the child", async () => {
    const harness = await arrange({ daemonJson: () => "other-pid" });
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    const pid = harness.children[0]?.pid;
    await harness.filesystem.writeFileAtomic(
      daemonJsonPath,
      JSON.stringify({ httpPort, pid, token, version: "0.21.28" }),
    );
    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("is not ready while the port is not listening, and ready once it is", async () => {
    const harness = await arrange({ listening: false });
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    harness.probe.startListening(httpPort);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("is not ready while a health read rejects, and ready once it answers", async () => {
    const harness = await arrange();
    harness.health.rejectWith(new Error("ECONNREFUSED"));
    harness.begin();
    await advanceBy(harness, 5_000);
    expect(stateOf(harness)).toBe("starting");

    harness.health.respondWith(healthyBody);
    await advanceUntil(harness, () => stateOf(harness) === "running", 10_000);

    expect(stateOf(harness)).toBe("running");
  });

  it("stops the child and reports wrong-version naming both protocols when /health answers protocol 3", async () => {
    const harness = await arrange();
    harness.health.respondWith({ rpcProtocolVersion: 3, service: "agent-device-daemon" });

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({
      message: "agent-device 0.21.28 speaks RPC protocol 3, need 2",
      reason: "wrong-version",
    });
    expect(unavailable(harness).remedy).toContain("RPC protocol 2");
    for (const phrase of restartCommand) expect(unavailable(harness).remedy).toContain(phrase);
    expect(harness.processes.signals).toEqual([
      { pid: harness.children[0]?.pid, signal: "SIGTERM" },
    ]);
  });

  it.each([
    ["another service", { rpcProtocolVersion: 2, service: "something-else" }],
    ["no numeric protocol", { rpcProtocolVersion: "2", service: "agent-device-daemon" }],
  ])(
    "stops the child and reports not-agent-device without retrying when /health answers with %s",
    async (_case, body) => {
      const harness = await arrange();
      harness.health.respondWith(body);

      await advancing(harness, harness.begin());

      expect(unavailable(harness)).toMatchObject({
        message: "/health did not answer as agent-device",
        reason: "not-agent-device",
      });
      expect(harness.processes.signals).toEqual([
        { pid: harness.children[0]?.pid, signal: "SIGTERM" },
      ]);
      await advanceBy(harness, 120_000);
      expect(daemonSpawns(harness)).toHaveLength(1);
      expect(stateOf(harness)).toBe("unavailable");
    },
  );
});

describe("AgentDeviceSupervisor failed starts", () => {
  it("kills the child after 15 s without readiness, removes the record only after it exits, and reports start-failed naming the timeout", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    const remove = harness.filesystem.rm.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "rm").mockImplementation(async (path) => {
      if (path === recordPath) harness.events.push("record removed");
      return remove(path);
    });
    const spawnedAt = harness.clock.now();

    await advancing(harness, harness.begin());

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("timed out");
    expect(unavailable(harness).remedy).toContain("30 s");
    expect(unavailable(harness).remedy).toContain("simlock daemon logs");
    expect(harness.clock.now() - spawnedAt).toBeGreaterThanOrEqual(15_000);
    expect(harness.clock.now() - spawnedAt).toBeLessThan(16_000);
    const pid = harness.children[0]?.pid;
    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(harness.events.slice(-2)).toEqual([`exit ${pid}`, "record removed"]);
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("reports start-failed naming the exit code when the child exits before readiness", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 1_000);

    harness.children[0]?.exit(7);
    await advancing(harness, harness.started as Promise<void>);

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("7");
  });

  it("reports start-failed and writes no record when the spawn throws", async () => {
    const harness = await run({ spawnThrows: new Error("EACCES: permission denied") });

    expect(warnings(harness).some((line) => line.includes("EACCES"))).toBe(true);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("EACCES");
    await expect(harness.filesystem.exists(recordPath)).resolves.toBe(false);
  });

  it("keeps the record and names the pid when the child is still alive 2 s after SIGKILL", async () => {
    const harness = await arrange({ daemonJson: () => "none" });
    harness.begin();
    await advanceBy(harness, 500);
    const pid = harness.children[0]?.pid as number;
    harness.processes.behaviours.set(pid, "immortal");

    await advancing(harness, harness.started as Promise<void>);

    expect(harness.processes.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain(String(pid));
    expect(
      warnings(harness).some((line) =>
        line.includes(`agent-device (simulators) daemon pid ${pid} is still alive after SIGKILL`),
      ),
    ).toBe(true);
    expect(await readJson(harness, recordPath)).toMatchObject({ pid });
  });

  it("resolves start() with start-failed carrying the message when the filesystem throws unexpectedly while writing the policy file", async () => {
    const harness = await arrange();
    const write = harness.filesystem.writeFileAtomic.bind(harness.filesystem);
    vi.spyOn(harness.filesystem, "writeFileAtomic").mockImplementation(async (path, ...rest) => {
      if (path === policyPath) throw new Error("disk on fire");
      return write(path, ...rest);
    });

    await expect(advancing(harness, harness.begin())).resolves.toBeUndefined();

    expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
    expect(unavailable(harness).message).toContain("disk on fire");
    expect(daemonSpawns(harness)).toEqual([]);
  });
});
