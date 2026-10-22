import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeUpdaterLauncher } from "./updater-launcher.js";

const trees: string[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => rm(tree, { recursive: true, force: true })));
});

describe("NodeUpdaterLauncher", () => {
  it("runs the entry detached with its arguments, streams stdout lines and appends stderr to the log", async () => {
    const tree = await realpath(await mkdtemp(join(tmpdir(), "simlock-updater-")));
    trees.push(tree);
    const entry = join(tree, "main.js");
    await writeFile(
      entry,
      `const { execFileSync } = require("node:child_process");
const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]));
console.log(JSON.stringify({ argv: process.argv.slice(2), home: process.env.SIMLOCK_HOME, leader: group === process.pid }));
console.log("second");
console.error("to the log");
process.exit(3);`,
    );
    const logPath = join(tree, "daemon.log");
    await writeFile(logPath, "earlier\n");

    const updater = await new NodeUpdaterLauncher().launch({
      entry,
      from: "0.3.0",
      to: "0.4.0",
      role: "gateway",
      pid: 4242,
      simlockHome: "/home/.simlock",
      logPath,
    });
    const lines: string[] = [];
    for await (const line of updater.lines) lines.push(line);

    expect(lines).toEqual([
      JSON.stringify({
        argv: ["--from", "0.3.0", "--to", "0.4.0", "--pid", "4242", "--gateway"],
        home: "/home/.simlock",
        leader: true,
      }),
      "second",
    ]);
    await expect(updater.exited).resolves.toBe(3);
    await expect(readFile(logPath, "utf8")).resolves.toBe("earlier\nto the log\n");
  });

  it("does not let the updater's stdout pipe keep this process alive, because the updater waits for this process to exit", async () => {
    const tree = await realpath(await mkdtemp(join(tmpdir(), "simlock-updater-")));
    trees.push(tree);
    const entry = join(tree, "main.js");
    await writeFile(entry, `console.log(process.pid);\nsetTimeout(() => undefined, 60_000);`);

    const updater = await new NodeUpdaterLauncher().launch({
      entry,
      from: "0.3.0",
      to: "0.4.0",
      role: "worker",
      pid: 4242,
      simlockHome: "/home/.simlock",
      logPath: join(tree, "daemon.log"),
    });
    const pid = Number(
      ((await updater.lines[Symbol.asyncIterator]().next()).value as string).trim(),
    );
    try {
      // why: Node offers no public way to ask whether a socket holds the event loop open, so this reads the handle behind the pipe.
      const pipe = (updater.lines as unknown as { input: { _handle: { hasRef(): boolean } } })
        .input;
      expect(pipe._handle.hasRef()).toBe(false);
    } finally {
      process.kill(pid);
      await updater.exited;
    }
  });
});
