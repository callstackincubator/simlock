import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, REPO_ROOT, withSharedDaemon, type SharedTestEnv } from "./index.js";

const execFileAsync = promisify(execFile);

// why: teardown after a failure is seen only from a vitest run of its own. Its flows fail as the
// slow-lane runs of #1102 did (a shared daemon's beforeAll, as warmUp; a per-test daemon's test)
// and record each socket path, which the daemon's "Daemon started" log line names. The shared
// daemon's home is torn down twice, the second time over an empty daemon.log, as in a slow-lane
// run whose suite teardown failed on an emulator still writing into the home and the file's
// afterAll then tore it down again.
const FAILING_FLOWS = `
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
    await env.teardown();
    await mkdir(env.dataDirectory, { recursive: true });
    await writeFile(join(env.dataDirectory, "daemon.log"), "");
    await env.teardown();
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
  it("after a run whose flows fail, leaves the log of each daemon it started in SIMLOCK_E2E_LOG_DIR, and a second teardown of the same home does not replace it", async () => {
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

async function laneEnv(): Promise<SharedTestEnv> {
  return withSharedDaemon({
    configOverrides: {
      http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
    },
    keepSeeds: true,
  });
}

async function tokenCount(env: SharedTestEnv): Promise<number> {
  const listed = await env.cli(["token", "list"]);
  expect(listed.code, listed.stderr).toBe(0);
  return (listed.json as { tokens: unknown[] }).tokens.length;
}

// why: the iOS driver's seed key joins its two parts with a NUL, and a seed is found by that exact key.
const SEED_KEY = "Pixel 9\u0000android-36";

function sourceRows(home: string, specKey: string): Record<string, unknown>[] {
  const database = new DatabaseSync(join(home, "state.db"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    return database
      .prepare(
        "SELECT source_id, state, folder FROM android_source_data WHERE spec_key = ? ORDER BY source_id",
      )
      .all(specKey);
  } finally {
    database.close();
  }
}

function insertSource(
  home: string,
  sourceId: string,
  state: string,
  folder: string,
  specKey = `kind-of-${sourceId}`,
): void {
  const database = new DatabaseSync(join(home, "state.db"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database
      .prepare(
        `INSERT INTO android_source_data (source_id, kind, state, spec_key, model, os_version,
           image_tag, folder, avd_name, image_identity, emulator_version, created_at)
         VALUES (?, 'seed', ?, ?, 'Pixel 9', '36', 'google_apis', ?, 'simlock', 'image', '36.1.9', 1)`,
      )
      .run(sourceId, state, specKey, folder);
  } finally {
    database.close();
  }
}

describe("withSharedDaemon with keepSeeds", () => {
  it("gives the next env the same home and instance id with the ready seed's row and folder the first env left, and without its unfinished seed, device folder, token or events", async () => {
    const laneHome = join(tmpdir(), `simlock-lane-${randomBytes(3).toString("hex")}`);
    process.env.SIMLOCK_E2E_LANE_HOME = laneHome;
    try {
      const first = await laneEnv();
      const root = join(first.home, "devices", "android");
      const ready = join(root, "sources", "seed_ready");
      const unfinished = join(root, "sources", "seed_making");
      const device = join(root, "dev_1");
      let instance: string;
      let recorded: string;
      try {
        for (const folder of [ready, unfinished, device]) {
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, "userdata.img"), "data", "utf8");
        }
        // why: a driver records its root as the filesystem resolves it, which on macOS is another spelling of a home under `/tmp` or `/var`.
        recorded = join(await realpath(join(root, "sources")), "seed_ready");
        insertSource(first.home, "seed_ready", "ready", recorded, SEED_KEY);
        insertSource(first.home, "seed_making", "making", unfinished);
        const created = await first.cli(["token", "create", "--role", "operator"]);
        expect(created.code, created.stderr).toBe(0);
        expect(await tokenCount(first)).toBe(1);
        instance = await readFile(join(first.home, "instance.json"), "utf8");
      } finally {
        await first.teardown();
      }

      const second = await laneEnv();
      try {
        expect(second.home).toBe(laneHome);
        expect(await readFile(join(second.home, "instance.json"), "utf8")).toBe(instance);
        expect(sourceRows(second.home, SEED_KEY)).toEqual([
          { folder: recorded, source_id: "seed_ready", state: "ready" },
        ]);
        expect(await readFile(join(ready, "userdata.img"), "utf8")).toBe("data");
        expect([unfinished, device].filter((folder) => existsSync(folder))).toEqual([]);
        expect(await tokenCount(second)).toBe(0);
        const started = (await second.events()).filter((entry) => entry.event === "daemon.started");
        expect(started).toHaveLength(1);
      } finally {
        await second.teardown();
      }
    } finally {
      delete process.env.SIMLOCK_E2E_LANE_HOME;
      await rm(laneHome, { force: true, recursive: true });
    }
  });
});
