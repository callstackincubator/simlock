import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FakeClock,
  JsonLinesLogger,
  MemoryLogSink,
  ProcessSpawnError,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ScriptedProcessExpectation,
} from "../ports/index.js";
import { runSupervisor } from "./service-main.js";

const name = "com.callstack.simlock.worker";
const installId = "6f1c1b0e-0000-4000-8000-000000000001";
const home = "/h/.simlock";
// why: the supervisor resolves SIMLOCK_HOME to an absolute path, which on Windows gains the current drive.
const homeDirectory = resolve(home);
const nodePath = "/opt/node/node.exe";
const mainPath = "/opt/simlock/dist/daemon/main.js";
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const goodArgv = (...gateway: string[]): string[] => argvFor(installId, ...gateway);
const argvFor = (id: string, ...gateway: string[]): string[] => [
  ...gateway,
  "--task",
  name,
  "--install-id",
  id,
  "--environment",
  encode({ SIMLOCK_HOME: home, PATH: "saved" }),
];

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const result = (code: number | null, signal?: NodeJS.Signals): ProcessResult => ({
  code,
  stdout: "",
  stderr: "",
  ...(signal === undefined ? {} : { signal }),
});
const taskXml = (id: string): string =>
  `<Task><Exec><Arguments>--headless "${nodePath}" "/s/service-main.js" --task ${name} --install-id ${id} --environment e30</Arguments></Exec></Task>`;
const query = { command: "schtasks", args: ["/query", "/tn", name, "/xml"] };

describe("the Windows supervisor (#1698)", () => {
  async function supervise(options: {
    readonly argv: readonly string[];
    readonly script: (
      daemon: (outcome: ProcessResult, hangs?: boolean) => ScriptedProcessExpectation,
    ) => ScriptedProcessExpectation[];
    readonly failSpawns?: (command: string, attempt: number) => boolean;
    readonly steps?: number;
  }): Promise<{
    readonly exit: number | undefined;
    readonly runner: ScriptedProcessRunner;
    readonly startedAt: number[];
    readonly lines: string[];
    readonly logPaths: string[];
  }> {
    const clock = new FakeClock(0);
    const startedAt: number[] = [];
    const daemon = (outcome: ProcessResult, hangs = false): ScriptedProcessExpectation => ({
      match: {
        command: nodePath,
        args: options.argv[0] === "--gateway" ? [mainPath, "--gateway"] : [mainPath],
      },
      result: outcome,
      hangs,
      onSpawn: () => {
        startedAt.push(clock.now());
      },
    });
    const scripted = new ScriptedProcessRunner(options.script(daemon));
    let attempts = 0;
    const runner: ProcessRunner = {
      run: (command, args, runOptions) => {
        if (options.failSpawns?.(command, attempts++) === true) {
          throw new ProcessSpawnError(command, args);
        }
        return scripted.run(command, args, runOptions);
      },
      spawn: (command, args, spawnOptions) => {
        if (options.failSpawns?.(command, attempts++) === true) {
          throw new ProcessSpawnError(command, args);
        }
        return scripted.spawn(command, args, spawnOptions);
      },
      spawnStreaming: (command, args, streamOptions) =>
        scripted.spawnStreaming(command, args, streamOptions),
    };
    const sink = new MemoryLogSink();
    const logPaths: string[] = [];
    let exit: number | undefined;
    void runSupervisor({
      argv: options.argv,
      env: { PATH: "own", KEEP: "1" },
      nodePath,
      mainPath,
      runner,
      clock,
      openLog: (path) => {
        logPaths.push(path);
        return new JsonLinesLogger({ clock, sink, level: "info", module: "supervisor" });
      },
    }).then((code) => {
      exit = code;
    });
    // why: one second a step, so a restart delay longer or shorter than 10 s lands on another start time.
    for (let step = 0; step < (options.steps ?? 120) && exit === undefined; step += 1) {
      await settle();
      clock.advance(1_000);
    }
    await settle();
    const lines = sink.records.map((record) => `${record.level}: ${record.message}`);
    return { exit, runner: scripted, startedAt, lines, logPaths };
  }

  it("the supervisor starts the daemon with the saved variables and waits for it, restarts it 10 s after a failure while its task is still the one that started it, and stops when the daemon exits 0, the task is gone or names another install", async () => {
    const exited0 = await supervise({
      argv: goodArgv(),
      script: (daemon) => [daemon(result(0))],
    });
    expect(exited0.exit, "exit 0 ends the supervisor with 0").toBe(0);
    expect(exited0.runner.calls, "no restart").toHaveLength(1);
    expect(exited0.lines).toEqual([]);

    const failed = await supervise({
      argv: goodArgv(),
      script: (daemon) => [
        daemon(result(1)),
        { match: query, result: { ...result(0), stdout: taskXml(installId) } },
        daemon(result(null, "SIGKILL")),
        { match: query, result: { ...result(0), stdout: taskXml(installId) } },
        daemon(result(1)),
        { match: query, result: { ...result(0), stdout: taskXml(installId) } },
        daemon(result(0)),
      ],
    });
    expect(failed.exit).toBe(0);
    expect(failed.startedAt, "each restart 10 s after the failure").toEqual([
      0, 10_000, 20_000, 30_000,
    ]);
    expect(failed.lines).toEqual([
      "warn: Daemon exited (code 1); the service starts it again in 10 s",
      "warn: Daemon exited (signal SIGKILL); the service starts it again in 10 s",
      "warn: Daemon exited (code 1); the service starts it again in 10 s",
    ]);
    const first = failed.runner.calls[0];
    expect(first?.options.timeoutMs, "the daemon wait has no limit").toBeUndefined();
    expect(first?.options.stdio).toEqual({ file: join(homeDirectory, "daemon.log") });
    expect(first?.options.outlivesCaller, "ending the supervisor ends its daemon").toBeUndefined();
    expect(first?.options.env).toMatchObject({ PATH: "saved", KEEP: "1", SIMLOCK_HOME: home });
    expect(failed.logPaths[0]).toBe(join(homeDirectory, "daemon.log"));
    expect(
      failed.runner.calls
        .filter((call) => call.command === "schtasks")
        .map((call) => call.options.timeoutMs),
    ).toEqual([10_000, 10_000, 10_000]);

    const gateway = await supervise({
      argv: goodArgv("--gateway"),
      script: (daemon) => [daemon(result(0))],
    });
    expect(gateway.runner.calls[0]?.args).toEqual([mainPath, "--gateway"]);
    expect(gateway.runner.calls[0]?.options.stdio).toEqual({
      file: join(homeDirectory, "gateway", "daemon.log"),
    });

    const stops = [
      { label: "the task is gone", stdout: undefined, code: 1 },
      { label: "another install id", stdout: taskXml("another-id"), code: 0 },
      { label: "an install id that starts with ours", stdout: taskXml(`${installId}-2`), code: 0 },
    ];
    for (const stop of stops) {
      const stopped = await supervise({
        argv: goodArgv(),
        script: (daemon) => [
          daemon(result(1)),
          { match: query, result: { ...result(stop.code), stdout: stop.stdout ?? "" } },
        ],
      });
      expect(stopped.exit, stop.label).toBe(0);
      expect(stopped.runner.calls, stop.label).toHaveLength(2);
      expect(stopped.lines.at(-1), stop.label).toBe(
        `warn: The service ${name} is gone; the supervisor stops`,
      );
    }

    const unreadable = [
      { label: "the task read passes 10 s", failure: undefined, outcome: result(null) },
      { label: "the task read cannot be spawned", failure: "schtasks", outcome: result(0) },
    ];
    for (const read of unreadable) {
      const restarted = await supervise({
        argv: goodArgv(),
        failSpawns: (command) => command === read.failure,
        script: (daemon) => [
          daemon(result(1)),
          ...(read.failure === undefined ? [{ match: query, result: read.outcome }] : []),
          daemon(result(0)),
        ],
      });
      expect(restarted.exit, read.label).toBe(0);
      expect(restarted.startedAt, read.label).toEqual([0, 10_000]);
    }

    const dotted = await supervise({
      argv: argvFor("a.b"),
      script: (daemon) => [
        daemon(result(1)),
        { match: query, result: { ...result(0), stdout: taskXml("axb") } },
      ],
    });
    expect(dotted.exit, "a dot in our id is not a wildcard").toBe(0);
    expect(dotted.runner.calls).toHaveLength(2);

    const failedStart = await supervise({
      argv: goodArgv(),
      failSpawns: (command, attempt) => command === nodePath && attempt === 0,
      script: (daemon) => [
        { match: query, result: { ...result(0), stdout: taskXml(installId) } },
        daemon(result(0)),
      ],
    });
    expect(failedStart.exit).toBe(0);
    expect(failedStart.lines[0]).toBe(
      `warn: Daemon failed to start (Failed to spawn ${nodePath} ${mainPath}); the service starts it again in 10 s`,
    );
    expect(failedStart.startedAt).toEqual([10_000]);

    const waiting = await supervise({
      argv: goodArgv(),
      script: (daemon) => [daemon(result(0), true)],
    });
    expect(waiting.exit, "a running daemon keeps the run unsettled").toBeUndefined();

    for (const argv of [
      [],
      goodArgv().slice(2),
      ["--task", name, "--install-id", installId],
      [...goodArgv(), "extra"],
      ["--install-id", installId, "--task", name, "--environment", encode({})],
      goodArgv().slice(0, -1).concat("!!!"),
      goodArgv().slice(0, -1).concat("e30="),
      goodArgv().slice(0, -1).concat(encode(null)),
      ["--task", "a b", ...goodArgv().slice(2)],
      argvFor("a b"),
      goodArgv()
        .slice(0, -1)
        .concat(encode(["a"])),
      goodArgv()
        .slice(0, -1)
        .concat(encode({ PATH: 1 })),
    ]) {
      const refused = await supervise({ argv, script: () => [] });
      expect(refused.exit, argv.join(" ")).toBe(2);
      expect(refused.runner.calls, argv.join(" ")).toHaveLength(0);
    }
  });
});
