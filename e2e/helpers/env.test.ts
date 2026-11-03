import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, REPO_ROOT } from "./index.js";

const execFileAsync = promisify(execFile);

// why: teardown after a failure is seen only from a vitest run of its own. Its flows fail as the
// slow-lane runs of #1102 did (a shared daemon's beforeAll, as warmUp; a per-test daemon's test)
// and record each socket path, which the daemon's "Daemon started" log line names.
const FAILING_FLOWS = `
import { appendFile } from "node:fs/promises";
import { withDaemon, withSharedDaemon } from ${JSON.stringify(join(REPO_ROOT, "e2e/helpers/env.ts"))};

const record = (env) => appendFile(process.env.FIXTURE_SOCKETS, env.socketPath + "\\n");

describe("a suite whose beforeAll fails, as warmUp does", () => {
  let env;
  beforeAll(async () => {
    env = await withSharedDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port: Number(process.env.FIXTURE_PORT) } },
    });
    await record(env);
    throw new Error("waitFor timed out (2 warm-up devices ready; last observed: shutdown,ready)");
  });
  afterAll(async () => {
    await env?.teardown();
  });
  it("never runs", () => {});
});

it("a flow whose test fails", async () => {
  const env = await withDaemon();
  await record(env);
  expect("shutdown").toBe("ready");
});
`;

const CONFIG = `export default { test: { globals: true, include: ["flows.test.mjs"], testTimeout: 120000, hookTimeout: 120000 } };\n`;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
}

describe("withDaemon and withSharedDaemon teardown", () => {
  it("after a run whose flows fail, leaves the log of each daemon it started in SIMLOCK_E2E_LOG_DIR", async () => {
    const work = await mkdtemp(join(tmpdir(), "simlock-e2e-kept-logs-"));
    try {
      const logDirectory = join(work, "daemon-logs");
      const sockets = join(work, "sockets.txt");
      await mkdir(logDirectory);
      await writeFile(join(work, "flows.test.mjs"), FAILING_FLOWS, "utf8");
      await writeFile(join(work, "vitest.config.mjs"), CONFIG, "utf8");

      const run = await execFileAsync(
        process.execPath,
        [join(REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.mjs"],
        {
          cwd: work,
          env: {
            ...process.env,
            FIXTURE_PORT: String(await freeLoopbackPort()),
            FIXTURE_SOCKETS: sockets,
            SIMLOCK_E2E_LOG_DIR: logDirectory,
          },
        },
      ).then(
        () => ({ code: 0, output: "" }),
        (error: { code: number; stdout: string; stderr: string }) => ({
          code: error.code,
          output: error.stdout + error.stderr,
        }),
      );

      expect(run.output).toContain("waitFor timed out (2 warm-up devices ready");
      expect(run.output).toContain("a flow whose test fails");
      expect(run.code).toBe(1);
      const started = (await readFile(sockets, "utf8")).trim().split("\n");
      expect(started).toHaveLength(2);

      const kept = await filesUnder(logDirectory);
      const lost = started.filter(
        (socketPath) => !kept.some((text) => text.includes(`"socketPath":"${socketPath}"`)),
      );
      expect(lost).toEqual([]);
    } finally {
      await rm(work, { force: true, recursive: true });
    }
  });
});
