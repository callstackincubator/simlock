import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeDaemonLauncher, startErrorFrom } from "./daemon-launcher.js";

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
    // A relative SIMLOCK_HOME resolves against whatever directory reads it, so passing the
    // variable through unresolved would let the daemon build its device roots somewhere the
    // process that launched it never looks.
    const launcher = new NodeDaemonLauncher({
      args: ["-e", "console.log(process.env.SIMLOCK_HOME)"],
      command: process.execPath,
      logPath,
      simlockHome: "/resolved/simlock/home",
    });

    try {
      await launcher.launch();
      await expect
        .poll(async () => (await readFile(logPath, "utf8")).trim())
        .toBe("/resolved/simlock/home");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates the daemon log it hands the child owner-only", async () => {
    // why: #685: when the CLI or MCP server auto-launches the daemon, this `open(path, "a")` is
    // what first creates `daemon.log` -- the daemon's own sink only appends afterwards. A
    // restrictive umask in the test environment would mask what the code asks for, so pin
    // the one every real host starts from.
    const previousUmask = process.umask(0o022);
    const directory = await mkdtemp(join(tmpdir(), "simlock-launcher-"));
    const logPath = join(directory, "daemon.log");
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
    } finally {
      process.umask(previousUmask);
      await rm(directory, { force: true, recursive: true });
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
