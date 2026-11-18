import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeDaemonLauncher, NodeDaemonLauncher, startErrorFrom } from "./daemon-launcher.js";
import { launcherFor } from "./service-launcher.js";
import {
  FakeServiceManager,
  MemoryFilesystem,
  type ProcessResult,
  ScriptedProcessRunner,
  type ServiceState,
  TaskSchedulerServiceManager,
} from "./index.js";

// why: lets one test refuse a mkdir of one existing folder, as Windows does for a drive root; every
// other call goes to the real `mkdir`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

describe("NodeDaemonLauncher", () => {
  it("rejects asynchronous spawn failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    try {
      await expect(
        new NodeDaemonLauncher({
          args: [],
          command: join(directory, "missing-command"),
          logPath: join(directory, "daemon.log"),
          simlockHome: directory,
        }).launch(),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("hands the daemon the home the launching process already resolved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "daemon.log");
    const resolvedHome = join(directory, "resolved", "simlock", "home");
    // why: A relative SIMLOCK_HOME resolves against whatever directory reads it, so passing the
    // variable through unresolved would let the daemon build its device roots somewhere the
    // process that launched it never looks.
    const launcher = new NodeDaemonLauncher({
      args: ["-e", "console.log(process.env.SIMLOCK_HOME)"],
      command: process.execPath,
      logPath,
      simlockHome: resolvedHome,
    });

    try {
      await launcher.launch();
      await expect.poll(async () => (await readFile(logPath, "utf8")).trim()).toBe(resolvedHome);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates the daemon log it hands the child, and the data directory it lives in, owner-only", async () => {
    // why: #685: when the CLI or MCP server auto-launches the daemon, this `open(path, "a")` is
    // what first creates `daemon.log` -- the daemon's own sink only appends afterwards -- and on
    // a fresh machine the launch creates the data directory too. A restrictive umask in the test
    // environment would mask what the code asks for, so pin the one every real host starts from.
    const previousUmask = process.umask(0o022);
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "home", "daemon.log");
    const launcher = new NodeDaemonLauncher({
      args: ["-e", "console.log('out')"],
      command: process.execPath,
      logPath,
      simlockHome: directory,
    });
    try {
      await launcher.launch();
      await expect.poll(async () => (await readFile(logPath, "utf8")).trim()).toBe("out");

      expect((await stat(logPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "home"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previousUmask);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates SIMLOCK_HOME 0700 under umask 002, and leaves an existing one's mode", async () => {
    const previousUmask = process.umask(0o002);
    const root = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    try {
      const modes: Record<string, number> = {};
      for (const [name, existing] of [
        ["created", undefined],
        ["existing", 0o775],
      ] as const) {
        const home = join(root, name);
        if (existing !== undefined) {
          await mkdir(home);
          await chmod(home, existing);
        }
        await new NodeDaemonLauncher({
          args: ["-e", "0"],
          command: process.execPath,
          logPath: join(home, "gateway", "daemon.log"),
          simlockHome: home,
        }).launch();
        modes[name] = (await stat(home)).mode & 0o777;
      }
      expect(modes).toEqual({ created: 0o700, existing: 0o775 });
    } finally {
      process.umask(previousUmask);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("starts the daemon when the folder holding SIMLOCK_HOME exists but refuses mkdir", async () => {
    // why: #1663: on Windows `mkdir('D:\\')`, recursive or not, rejects EPERM though the root exists
    // (Node 22.23.5, Windows 11). The temporary folder stands in for the drive root.
    const driveRoot = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const home = join(driveRoot, "simlock");
    const logPath = join(home, "daemon.log");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(mkdir).mockImplementation(async (path, options) => {
      if (path === driveRoot)
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${driveRoot}'`), {
          code: "EPERM",
        });
      return actual.mkdir(path, options);
    });
    try {
      const launch = new NodeDaemonLauncher({
        args: ["-e", "console.log('out')"],
        command: process.execPath,
        logPath,
        simlockHome: home,
      }).launch();
      await expect(launch).resolves.toHaveProperty("exited");
      await expect.poll(async () => (await readFile(logPath, "utf8")).trim()).toBe("out");
    } finally {
      vi.mocked(mkdir).mockImplementation(actual.mkdir);
      await rm(driveRoot, { force: true, recursive: true });
    }
  });

  it("combines stdout and stderr in an append-only log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "daemon.log");
    const launcher = new NodeDaemonLauncher({
      args: ["-e", "console.log('out'); console.error('err')"],
      command: process.execPath,
      logPath,
      simlockHome: directory,
    });
    try {
      await launcher.launch();
      await launcher.launch();
      await expect
        .poll(async () => {
          const log = await readFile(logPath, "utf8");
          return [log.match(/out/g)?.length ?? 0, log.match(/err/g)?.length ?? 0];
        })
        .toEqual([2, 2]);
      expect(await readdir(directory)).toEqual(["daemon.log"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("NodeDaemonLauncher's LaunchedDaemon", () => {
  it("gives the exit code and only the log bytes written since the launch, across a rotation too", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "daemon.log");
    const older = `${JSON.stringify({ message: "Daemon failed to start", fields: { message: "older" } })}\n`;
    const launch = async (script: string) => {
      await rm(logPath, { force: true });
      await rm(`${logPath}.1`, { force: true });
      await writeFile(logPath, older);
      const launched = await new NodeDaemonLauncher({
        args: ["-e", script, logPath],
        command: process.execPath,
        logPath,
        simlockHome: directory,
      }).launch();
      return { exit: await launched.exited, output: await launched.readOutput() };
    };
    try {
      const plain = await launch("console.log('newer'); process.exit(1)");
      const rotated = await launch(
        "const fs = require('node:fs'); const p = process.argv[1]; fs.renameSync(p, p + '.1'); console.log('tail'); fs.writeFileSync(p, 'fatal\\n'); process.exit(2)",
      );
      expect({ plain, rotated }).toEqual({
        plain: { exit: { code: 1, signal: null }, output: "newer\n" },
        rotated: { exit: { code: 2, signal: null }, output: "tail\nfatal\n" },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("refuses to read the log when neither file is the one the daemon was launched into", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "daemon.log");
    try {
      await writeFile(logPath, "older\n");
      const launched = await new NodeDaemonLauncher({
        args: [
          "-e",
          "require('node:fs').rmSync(process.argv[1]); require('node:fs').writeFileSync(process.argv[1], 'x'); require('node:fs').writeFileSync(process.argv[1] + '.1', 'y')",
          logPath,
        ],
        command: process.execPath,
        logPath,
        simlockHome: directory,
      }).launch();
      await launched.exited;
      await expect(launched.readOutput()).rejects.toThrow("daemon.log was replaced");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("NodeDaemonLauncher in a parent that awaits nothing", () => {
  it("lets the parent process exit while the launched daemon keeps running", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const launcherModule = fileURLToPath(new URL("./daemon-launcher.ts", import.meta.url));
    const parentScript = `
      const { NodeDaemonLauncher } = await import(${JSON.stringify(launcherModule)});
      const launcher = new NodeDaemonLauncher({
        args: ["-e", "console.log(process.pid); setTimeout(() => {}, 30000)"],
        command: process.execPath,
        logPath: ${JSON.stringify(join(directory, "daemon.log"))},
        simlockHome: ${JSON.stringify(directory)},
      });
      await launcher.launch();
    `;
    const parent = spawn(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", parentScript],
      { stdio: "ignore" },
    );
    let childPid: number | undefined;
    try {
      const outcome = await Promise.race([
        new Promise<string>((resolve) => parent.once("exit", () => resolve("parent exited"))),
        new Promise<string>((resolve) => setTimeout(() => resolve("parent still running"), 8000)),
      ]);
      expect(outcome).toBe("parent exited");
      await expect
        .poll(async () => (await readFile(join(directory, "daemon.log"), "utf8")).trim())
        .toMatch(/^\d+$/);
      childPid = Number((await readFile(join(directory, "daemon.log"), "utf8")).trim());
      expect(() => process.kill(childPid as number, 0)).not.toThrow();
    } finally {
      parent.kill();
      if (childPid !== undefined) process.kill(childPid);
      await rm(directory, { force: true, recursive: true });
    }
    // why: the 8 s guard above must be able to fire before vitest's own 5 s default does.
  }, 20_000);
});

describe("startErrorFrom", () => {
  it("names the last fatal line's message, else the exit code or signal", () => {
    const fatal = (message: string): string =>
      JSON.stringify({ message: "Daemon failed to start", fields: { message } });
    const info = JSON.stringify({ message: "Daemon listening", fields: { message: "ready" } });
    const exit1 = { code: 1, signal: null };
    const cases = [
      {
        label: "the fatal line alone",
        exit: exit1,
        output: `${fatal("boom")}\n`,
        error: "The daemon could not start: boom",
      },
      {
        label: "the fatal line after other lines",
        exit: exit1,
        output: `${info}\n${fatal("boom")}\n`,
        error: "The daemon could not start: boom",
      },
      {
        label: "two fatal lines",
        exit: exit1,
        output: `${fatal("first")}\n${fatal("second")}\n`,
        error: "The daemon could not start: second",
      },
      {
        label: "no fatal line, code 1",
        exit: exit1,
        output: `${info}\n`,
        error: "The daemon exited with code 1 while starting; see `simlock daemon logs`",
      },
      {
        label: "no fatal line, SIGKILL",
        exit: { code: null, signal: "SIGKILL" },
        output: "",
        error: "The daemon exited with code SIGKILL while starting; see `simlock daemon logs`",
      },
      {
        label: "a non-JSON line before the fatal line",
        exit: exit1,
        output: `not json\n${fatal("boom")}\n`,
        error: "The daemon could not start: boom",
      },
    ];
    expect(cases.map((c) => ({ label: c.label, error: startErrorFrom(c.exit, c.output) }))).toEqual(
      cases.map((c) => ({ label: c.label, error: c.error })),
    );
  });
});

describe("launcherFor's fallback to spawning", () => {
  const plist = "/Users/me/Library/LaunchAgents/com.callstack.simlock.worker.plist";
  const name = "com.callstack.simlock.worker";

  it("spawns the daemon as today, with a notice when the service is not loaded or broken", async () => {
    const cases: readonly {
      readonly label: string;
      readonly state: ServiceState | undefined;
      readonly notices: readonly string[];
    }[] = [
      { label: "no service manager on this platform", state: undefined, notices: [] },
      { label: "no service", state: { state: "not-installed" }, notices: [] },
      {
        label: "not loaded",
        state: { state: "not-loaded", path: plist },
        notices: [`Service ${name} is not loaded; started the daemon without it.`],
      },
      {
        label: "broken, one path gone",
        state: { state: "broken", path: plist, missing: ["/old/node"] },
        notices: [
          `Service ${name} is broken (/old/node is gone); started the daemon without it. Run simlock daemon install again.`,
        ],
      },
      {
        label: "broken, both paths gone",
        state: { state: "broken", path: plist, missing: ["/old/node", "/old/main.js"] },
        notices: [
          `Service ${name} is broken (/old/node, /old/main.js are gone); started the daemon without it. Run simlock daemon install again.`,
        ],
      },
    ];
    for (const testCase of cases) {
      const serviceManager =
        testCase.state === undefined
          ? undefined
          : new FakeServiceManager({ state: testCase.state });
      const spawner = new FakeDaemonLauncher();
      const notices: string[] = [];
      const launcher = launcherFor({
        role: "worker",
        root: "/Users/me/.simlock",
        dataDirectory: "/Users/me/.simlock",
        mainPath: "/opt/simlock/dist/daemon/main.js",
        nodePath: "/opt/node/bin/node",
        home: "/Users/me",
        env: {},
        serviceManager,
        notify: (line) => notices.push(line),
        spawner,
      });

      await launcher.launch();

      expect(spawner.launches, testCase.label).toBe(1);
      expect(serviceManager?.starts ?? [], testCase.label).toEqual([]);
      expect(notices, testCase.label).toEqual(testCase.notices);
    }
  });
});

describe("launcherFor with an installed service", () => {
  it("starts an installed service through the manager that owns it, with that manager's definition", async () => {
    const cases = [
      { manager: "systemd" as const, path: "/home/me/.config/systemd/user/" },
      { manager: "launchd" as const, path: "/home/me/Library/LaunchAgents/" },
    ];
    for (const testCase of cases) {
      const serviceManager = new FakeServiceManager({
        manager: testCase.manager,
        state: { state: "installed", path: testCase.path },
      });
      const spawner = new FakeDaemonLauncher();
      const launcher = launcherFor({
        role: "worker",
        root: "/home/me/.simlock",
        dataDirectory: "/home/me/.simlock",
        mainPath: "/opt/simlock/dist/daemon/main.js",
        nodePath: "/opt/node/bin/node",
        home: "/home/me",
        env: {},
        serviceManager,
        notify: () => undefined,
        spawner,
      });

      await launcher.launch();

      expect(spawner.launches, testCase.manager).toBe(0);
      expect(
        serviceManager.starts.map((definition) => definition.path),
        testCase.manager,
      ).toEqual([
        `${testCase.path}com.callstack.simlock.worker.${testCase.manager === "systemd" ? "service" : "plist"}`,
      ]);
    }
  });
});

describe("launcherFor with the Windows task (#1698)", () => {
  const name = "com.callstack.simlock.worker";
  const nodePath = "/opt/node/node.exe";
  const supervisor = "/opt/simlock/dist/daemon/service-main.js";
  const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
  const query = {
    command: "cmd.exe",
    args: ["/d", "/c", `chcp 65001 >nul && schtasks /query /tn ${name} /xml`],
  };
  const run = { command: "schtasks", args: ["/run", "/tn", name] };
  const taskXml = `<Task><Settings><Enabled>true</Enabled></Settings><Exec><Arguments>--headless "${nodePath}" "${supervisor}" --task ${name}</Arguments></Exec></Task>`;
  const session = [
    {
      match: {
        command: "cmd.exe",
        args: ["/d", "/c", "chcp 65001 >nul && whoami /user /fo csv /nh"],
      },
      result: ok('"desktop\\me","S-1-5-21-1"\r\n'),
    },
    {
      match: {
        command: "tasklist",
        args: ["/fi", "USERNAME eq desktop\\me", "/fi", "SESSION ne 0", "/fo", "csv", "/nh"],
      },
      result: ok('"sihost.exe","4242","Console","1","20,000 K"\r\n'),
    },
  ];

  async function launchWith(options: {
    readonly script: ConstructorParameters<typeof ScriptedProcessRunner>[0];
    readonly files: readonly string[];
  }): Promise<{
    readonly spawner: FakeDaemonLauncher;
    readonly notices: string[];
    readonly runner: ScriptedProcessRunner;
    readonly launch: () => Promise<unknown>;
  }> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/opt/simlock/dist/daemon");
    await filesystem.mkdirp("/opt/node");
    for (const file of options.files) await filesystem.writeFileAtomic(file, "");
    const runner = new ScriptedProcessRunner(options.script);
    const spawner = new FakeDaemonLauncher();
    const notices: string[] = [];
    const launcher = launcherFor({
      role: "worker",
      root: "/Users/me/.simlock",
      dataDirectory: "/Users/me/.simlock",
      mainPath: "/opt/simlock/dist/daemon/main.js",
      nodePath,
      home: "/Users/me",
      env: {},
      serviceManager: new TaskSchedulerServiceManager({ runner, filesystem }),
      notify: (line) => notices.push(line),
      spawner,
    });
    return { spawner, notices, runner, launch: () => launcher.launch() };
  }

  it("a start runs the task when the service is installed and spawns the daemon, with the notice, when it is not loaded, broken or not installed", async () => {
    const installed = await launchWith({
      script: [{ match: query, result: ok(taskXml) }, ...session, { match: run, result: ok("") }],
      files: [nodePath, supervisor],
    });
    await installed.launch();
    expect(installed.spawner.launches, "installed: no spawn").toBe(0);
    expect(installed.runner.calls.at(-1)?.args, "installed: /run").toEqual(["/run", "/tn", name]);
    expect(installed.notices).toEqual([]);

    const notLoaded = await launchWith({
      script: [
        { match: query, result: ok(taskXml) },
        ...session.slice(0, 1),
        {
          match: session[1]?.match as never,
          result: ok("INFO: No tasks are running which match the specified criteria.\r\n"),
        },
      ],
      files: [nodePath, supervisor],
    });
    await notLoaded.launch();
    expect(notLoaded.spawner.launches, "not loaded: spawn").toBe(1);
    expect(notLoaded.notices).toEqual([
      `Service ${name} is not loaded; started the daemon without it.`,
    ]);

    const broken = await launchWith({
      script: [{ match: query, result: ok(taskXml) }],
      files: [supervisor],
    });
    await broken.launch();
    expect(broken.spawner.launches, "broken: spawn").toBe(1);
    expect(broken.notices).toEqual([
      `Service ${name} is broken (${nodePath} is gone); started the daemon without it. Run simlock daemon install again.`,
    ]);

    const none = await launchWith({
      script: [{ match: query, result: { code: 1, stdout: "", stderr: "ERROR" } }],
      files: [],
    });
    await none.launch();
    expect(none.spawner.launches, "not installed: spawn").toBe(1);
    expect(none.notices).toEqual([]);

    const refused = await launchWith({
      script: [
        { match: query, result: ok(taskXml) },
        ...session,
        { match: run, result: { code: 1, stdout: "", stderr: "ERROR: The task is disabled." } },
      ],
      files: [nodePath, supervisor],
    });
    await expect(refused.launch()).rejects.toThrow(
      `schtasks /run /tn ${name} failed: ERROR: The task is disabled.`,
    );
  });
});
