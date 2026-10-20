import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
