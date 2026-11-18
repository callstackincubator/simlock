import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFilesystem } from "./filesystem.js";
import { NodeNpmCli } from "./npm-cli.js";
import { NodeProcessRunner, type ProcessRunner, ScriptedProcessRunner } from "./process-runner.js";

const STUB_NPM = `
const [command, ...rest] = process.argv.slice(2);
if (rest.includes("simlock@noisy")) {
  process.stderr.write("a".repeat(1000) + "b".repeat(2000));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), script: process.argv[1], cwd: process.cwd() }) + "\\n");
`;

// why: Windows runs a program only by a name that ends in `.exe`.
const NODE = process.platform === "win32" ? "node.exe" : "node";

const trees: string[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => rm(tree, { recursive: true, force: true })));
});

async function stubNpm(
  runner: ProcessRunner = new NodeProcessRunner(),
): Promise<{ npm: NodeNpmCli; dataDirectory: string; script: string }> {
  const tree = await realpath(await mkdtemp(join(tmpdir(), "simlock-npm-")));
  trees.push(tree);
  const dataDirectory = join(tree, "data");
  await mkdir(dataDirectory);
  await mkdir(join(tree, "bin"));
  await mkdir(join(tree, "lib"));
  await symlink(process.execPath, join(tree, "bin", NODE));
  const script = join(tree, "lib", "npm-cli.js");
  await writeFile(script, STUB_NPM);
  await chmod(script, 0o755);
  await symlink("../lib/npm-cli.js", join(tree, "bin", "npm"));
  const npm = new NodeNpmCli({
    runner,
    filesystem: new NodeFilesystem(),
    dataDirectory,
    execPath: join(tree, "bin", NODE),
  });
  return { npm, dataDirectory, script };
}

// why: #1664: the official Windows installer puts node.exe, a POSIX shell wrapper named `npm` and
// `node_modules/npm/bin/npm-cli.js` side by side, with no symlink (Node 22.23.5, Windows 11). The
// wrapper's first lines are copied from that install; node reads them as JavaScript and fails.
const WINDOWS_NPM_WRAPPER = `#!/usr/bin/env bash

# This is used by the Node.js installer, which expects the cygwin/mingw
# shell script to already be present in the npm dependency folder.

(set -o igncr) 2>/dev/null && set -o igncr; # cygwin encoding fix
`;

async function windowsLayoutNpm(): Promise<{
  npm: NodeNpmCli;
  dataDirectory: string;
  script: string;
}> {
  const tree = await realpath(await mkdtemp(join(tmpdir(), "simlock-npm-")));
  trees.push(tree);
  const dataDirectory = join(tree, "data");
  await mkdir(dataDirectory);
  const nodejs = join(tree, "nodejs");
  await mkdir(join(nodejs, "node_modules", "npm", "bin"), { recursive: true });
  await symlink(process.execPath, join(nodejs, NODE));
  await writeFile(join(nodejs, "npm"), WINDOWS_NPM_WRAPPER);
  const script = join(nodejs, "node_modules", "npm", "bin", "npm-cli.js");
  await writeFile(script, STUB_NPM);
  const npm = new NodeNpmCli({
    runner: new NodeProcessRunner(),
    filesystem: new NodeFilesystem(),
    dataDirectory,
    execPath: join(nodejs, NODE),
  });
  return { npm, dataDirectory, script };
}

describe("NodeNpmCli", () => {
  it("runs npm with the daemon's Node, in its data directory", async () => {
    const { npm, dataDirectory, script } = await stubNpm();

    const calls = [
      { outcome: await npm.view("simlock@0.4.0"), argv: ["view", "simlock@0.4.0", "version"] },
      { outcome: await npm.install("simlock@0.4.0"), argv: ["i", "-g", "simlock@0.4.0"] },
      { outcome: await npm.globalRoot(), argv: ["root", "-g"] },
    ];

    for (const { outcome, argv } of calls) {
      expect(outcome.ok).toBe(true);
      const seen = JSON.parse(outcome.ok ? outcome.output : "{}") as Record<string, unknown>;
      expect(seen).toEqual({ argv, script, cwd: dataDirectory });
    }
  });

  it("runs npm-cli.js from node_modules beside Node when npm there is the installer's shell wrapper", async () => {
    const { npm, dataDirectory, script } = await windowsLayoutNpm();

    const outcomes = [
      await npm.view("simlock@0.4.0"),
      await npm.install("simlock@0.4.0"),
      await npm.globalRoot(),
    ];

    expect(outcomes).toEqual(
      [
        ["view", "simlock@0.4.0", "version"],
        ["i", "-g", "simlock@0.4.0"],
        ["root", "-g"],
      ].map((argv) => ({ ok: true, output: JSON.stringify({ argv, script, cwd: dataDirectory }) })),
    );
  });

  it("keeps the last 2000 characters of npm's stderr when it fails", async () => {
    const { npm } = await stubNpm();

    const outcome = await npm.install("simlock@noisy");

    expect(outcome).toEqual({ ok: false, message: "b".repeat(2000) });
  });

  it("kills npm at its limit and says so", async () => {
    const hung = { code: null, stdout: "", stderr: "" };
    const runner = new ScriptedProcessRunner(
      [
        ["view", "simlock@0.4.0", "version"],
        ["i", "-g", "simlock@0.4.0"],
        ["root", "-g"],
      ].map((args) => ({
        match: { command: /node$/, args: [/npm-cli\.js$/, ...args] },
        result: hung,
      })),
    );
    const { npm } = await stubNpm(runner);

    const outcomes = [
      await npm.view("simlock@0.4.0"),
      await npm.install("simlock@0.4.0"),
      await npm.globalRoot(),
    ];

    expect(outcomes).toEqual([
      { ok: false, message: "npm did not finish within 30 seconds" },
      { ok: false, message: "npm did not finish within 10 minutes" },
      { ok: false, message: "npm did not finish within 30 seconds" },
    ]);
    expect(runner.calls.map((call) => call.options.timeoutMs)).toEqual([30_000, 600_000, 30_000]);
  });
});
