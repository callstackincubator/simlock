import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freeLoopbackPort, REPO_ROOT, waitFor, withDaemon } from "../helpers/index.js";

const execFileAsync = promisify(execFile);
const BUILDS = [
  { version: "0.0.1-a", tag: "a" },
  { version: "0.0.1-b", tag: "latest" },
] as const;

let base: string;
let registry: ChildProcess | undefined;
let npmEnv: NodeJS.ProcessEnv;
let installedCli: string;

async function startRegistry(directory: string): Promise<{ url: string; token: string }> {
  const port = await freeLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const configPath = join(directory, "verdaccio.yaml");
  await writeFile(
    configPath,
    [
      `storage: ${join(directory, "storage")}`,
      "auth:",
      "  htpasswd:",
      `    file: ${join(directory, "htpasswd")}`,
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  simlock:",
      "    access: $all",
      "    publish: $authenticated",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log: { type: stdout, format: pretty, level: error }",
      "",
    ].join("\n"),
  );
  registry = spawn(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/verdaccio/bin/verdaccio"),
      "--config",
      configPath,
      "--listen",
      `127.0.0.1:${port}`,
    ],
    { stdio: "ignore" },
  );
  await waitFor(
    async () => {
      try {
        return (await fetch(`${url}/-/ping`)).ok;
      } catch {
        return false;
      }
    },
    { timeout: 60_000, label: "the local registry answers" },
  );
  const created = await fetch(`${url}/-/user/org.couchdb.user:e2e`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "e2e", password: "e2e-password", email: "e2e@example.com" }),
  });
  const { token } = (await created.json()) as { token: string };
  return { url, token };
}

async function npm(args: readonly string[]): Promise<void> {
  // why: npm reads `devEngines` from the project it runs in, and this repo's names pnpm.
  await execFileAsync("npm", args, { cwd: base, env: npmEnv, maxBuffer: 64 * 1024 * 1024 });
}

async function publishBuild(version: string, tag: string): Promise<void> {
  const directory = join(base, `package-${version}`);
  await mkdir(directory);
  await cp(join(REPO_ROOT, "dist"), join(directory, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  // why: a lifecycle script would rebuild the package from a folder that has no sources, and `devEngines` makes npm refuse to publish what pnpm builds.
  const {
    scripts: _scripts,
    devEngines: _devEngines,
    devDependencies: _devDependencies,
    ...publishable
  } = manifest;
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...publishable, version }, null, 2),
  );
  await npm(["publish", directory, "--tag", tag]);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "simlock-update-e2e-"));
  const { url, token } = await startRegistry(base);
  const host = url.replace("http:", "");
  const userConfig = join(base, "npmrc");
  await writeFile(userConfig, `registry=${url}/\n${host}/:_authToken=${token}\n`);
  const prefix = join(base, "prefix");
  npmEnv = {
    ...process.env,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: join(base, "globalrc"),
    npm_config_prefix: prefix,
    npm_config_cache: join(base, "cache"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  for (const { version, tag } of BUILDS) await publishBuild(version, tag);
  await npm(["install", "--global", "simlock@0.0.1-a"]);
  installedCli = join(prefix, "lib", "node_modules", "simlock", "dist", "cli", "main.js");
}, 600_000);

afterAll(async () => {
  registry?.kill("SIGTERM");
  await rm(base, { force: true, recursive: true });
});

describe("simlock update against a local npm registry", () => {
  it("takes a running 0.0.1-a to 0.0.1-b and prints that it is running, and refuses a version npm does not have while 0.0.1-a keeps running", async () => {
    const env = await withDaemon({ mode: "auto" });
    const run = (args: readonly string[]) =>
      env.cli(args, { entry: installedCli, env: npmEnv, timeout: 180_000 });
    const versionRunning = async () =>
      ((await run(["status", "--json"])).json as { daemon: { version: string } }).daemon.version;

    expect((await run(["daemon", "start"])).code).toBe(0);
    expect(await versionRunning()).toBe("0.0.1-a");

    const missing = await run(["update", "--version", "9.9.9"]);
    expect(missing.code).toBe(1);
    expect(missing.error?.code).toBe("UPDATE_RESOLVE_FAILED");
    expect(missing.error?.message).toContain("could not resolve simlock@9.9.9");
    expect(await versionRunning()).toBe("0.0.1-a");

    const updated = await run(["update"]).catch((error: unknown) => ({
      code: null,
      stdout: "",
      stderr: String(error),
    }));
    expect(updated.code, updated.stderr).toBe(0);
    expect(updated.stdout).toContain("Updating simlock 0.0.1-a → 0.0.1-b\n");
    expect(updated.stdout.endsWith("simlock 0.0.1-b is running\n")).toBe(true);
    await waitFor(async () => (await versionRunning()) === "0.0.1-b", {
      label: "the new daemon runs 0.0.1-b",
    });
  }, 480_000);
});
