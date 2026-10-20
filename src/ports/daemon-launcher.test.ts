import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeDaemonLauncher } from "./daemon-launcher.js";

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
