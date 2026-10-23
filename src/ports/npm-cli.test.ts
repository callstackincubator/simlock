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
  await symlink(process.execPath, join(tree, "bin", "node"));
  const script = join(tree, "lib", "npm-cli.js");
  await writeFile(script, STUB_NPM);
  await chmod(script, 0o755);
  await symlink("../lib/npm-cli.js", join(tree, "bin", "npm"));
  const npm = new NodeNpmCli({
    runner,
    filesystem: new NodeFilesystem(),
    dataDirectory,
    execPath: join(tree, "bin", "node"),
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
