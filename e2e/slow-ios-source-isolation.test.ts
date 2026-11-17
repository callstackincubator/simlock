import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";
import { sweepStaleDeviceSets } from "./helpers/ios-device-set.js";
import { DEVICE_READY_MS } from "./helpers/wait.js";

interface Grant {
  readonly deviceSet: string;
  readonly leaseId: string;
  readonly udid: string;
}

const LOG_ROOT = join(homedir(), "Library", "Logs", "CoreSimulator");
const BASELINE = "isolation";

async function lease(env: TestEnv, extra: readonly string[] = []): Promise<Grant> {
  const granted = await env.cli(
    ["lease", "--platform", "ios", "--agent-id", "isolation", "--detach", ...extra],
    { timeout: DEVICE_READY_MS },
  );
  expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
  const grant = granted.json as {
    device: { driverDeviceId: string };
    environment: Record<string, string>;
    lease: { id: string };
  };
  return {
    deviceSet: grant.environment.SIMLOCK_IOS_DEVICE_SET as string,
    leaseId: grant.lease.id,
    udid: grant.device.driverDeviceId,
  };
}

async function release(env: TestEnv, grant: Grant): Promise<void> {
  const released = await env.cli(["release", grant.leaseId]);
  expect(released.code, `release failed: ${released.stderr}`).toBe(0);
}

/** why: a file's size, modification time and hash are what "unchanged after the row turned ready" compares (ADR 0076). */
async function fingerprint(folder: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) result[path] = `link ${await readlink(path)}`;
    else if (entry.isFile()) {
      const { mtimeMs, size } = await stat(path);
      // why: a system service's cache file inside a source can be unreadable to the test (EPERM); the product records it as unreadable too, so its size and time stand for it.
      const hash = await readFile(path).then(
        (bytes) => createHash("sha256").update(bytes).digest("hex"),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EPERM" || error.code === "EACCES") return "unreadable";
          throw error;
        },
      );
      result[path] = `${size} ${mtimeMs} ${hash}`;
    }
  }
  return result;
}

function sourceFolder(home: string, kind: "seed" | "baseline"): string {
  const database = new DatabaseSync(join(home, "state.db"), { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const row = database
      .prepare(
        "SELECT set_path, udid FROM ios_source_data WHERE kind = ? AND state = 'ready' ORDER BY created_at DESC",
      )
      .get(kind) as { set_path: string; udid: string } | undefined;
    if (row === undefined) throw new Error(`no ready ${kind} source in state.db`);
    return join(row.set_path, row.udid);
  } finally {
    database.close();
  }
}

function seedThrowaway(home: string): string {
  const database = new DatabaseSync(join(home, "state.db"), { readOnly: true });
  try {
    const row = database
      .prepare("SELECT lineage FROM ios_source_data WHERE kind = 'seed' AND state = 'ready'")
      .get() as { lineage: string } | undefined;
    const [throwaway] = JSON.parse(row?.lineage ?? "[]") as string[];
    if (throwaway === undefined) throw new Error("the ready seed has no lineage");
    return throwaway;
  } finally {
    database.close();
  }
}

/** why: ADR 0076: a copy's `Logs` link names the copy's own folder, never the throwaway's or the saved-from lease's. */
async function expectOwnLogs(grant: Grant, strangers: readonly string[]): Promise<void> {
  const target = await readlink(join(grant.deviceSet, grant.udid, "data", "Library", "Logs"));
  expect(target.toUpperCase()).toContain(grant.udid.toUpperCase());
  for (const stranger of strangers) expect(target.toUpperCase()).not.toContain(stranger);
}

async function expectNoFolderNamedAfter(
  names: readonly string[],
  deviceSet: string,
): Promise<void> {
  for (const root of [deviceSet, LOG_ROOT]) {
    const entries = existsSync(root) ? await readdir(root) : [];
    for (const name of names) {
      expect(
        entries.filter((entry) => entry.toUpperCase() === name),
        `${root} holds a folder named after ${name}`,
      ).toEqual([]);
    }
  }
}

async function swapMilliseconds(env: TestEnv, udid: string): Promise<number> {
  const log = await readFile(env.logPath, "utf8");
  for (const line of log.split("\n")) {
    const match = new RegExp(
      `swapped \\d+ files and \\d+ links in (\\d+) ms for ${udid}`,
      "i",
    ).exec(line);
    if (match !== null) return Number(match[1]);
  }
  throw new Error(`the daemon log has no swap line for ${udid}`);
}

// why: this lane needs the real simctl toolchain on Xcode 27, hence darwin-only; it never installs a runtime.
describe.skipIf(process.platform !== "darwin")(
  "iOS source isolation (real simctl)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "leaves the seed unchanged after three leases and a saved baseline's source unchanged after two, gives every copy a Logs link to its own folder, brings back no folder named after the throwaway or the saved-from lease, and swaps a baseline's copy in under 1 s",
      { timeout: 2_400_000 },
      async () => {
        await sweepStaleDeviceSets();
        const env = await withDaemon({
          configOverrides: { log: { level: "debug" } },
          driver: "real",
        });

        // why: case 1, the seed, after three leases of one kind.
        const first = await lease(env);
        const seedFolder = sourceFolder(env.home, "seed");
        const throwaway = seedThrowaway(env.home).toUpperCase();
        const seedBefore = await fingerprint(seedFolder);
        await expectOwnLogs(first, [throwaway]);
        await release(env, first);
        for (let more = 0; more < 2; more += 1) {
          const next = await lease(env);
          await expectOwnLogs(next, [throwaway]);
          await release(env, next);
        }
        expect(await fingerprint(seedFolder), "the seed changed after its row was ready").toEqual(
          seedBefore,
        );

        // why: case 2, a baseline saved from a used lease, after two leases of it.
        const saved = await lease(env);
        const marker = join(saved.deviceSet, saved.udid, "data", "Documents", "isolation.txt");
        await mkdir(join(saved.deviceSet, saved.udid, "data", "Documents"), { recursive: true });
        await writeFile(marker, "used");
        const baseline = await env.cli(["baseline", "save", BASELINE, "--lease", saved.leaseId], {
          timeout: 600_000,
        });
        expect(baseline.code, `baseline save failed: ${baseline.stderr}`).toBe(0);
        const baselineFolder = sourceFolder(env.home, "baseline");
        const baselineBefore = await fingerprint(baselineFolder);
        const strangers = [throwaway, saved.udid.toUpperCase()];
        const copies: Grant[] = [];
        for (let n = 0; n < 2; n += 1) {
          const copy = await lease(env, ["--baseline", BASELINE]);
          copies.push(copy);
          // why: case 3, each copy's Logs link names its own folder.
          await expectOwnLogs(copy, strangers);
          await release(env, copy);
        }
        expect(
          await fingerprint(baselineFolder),
          "the baseline's source changed after its row was ready",
        ).toEqual(baselineBefore);

        // why: case 4, no folder named after the throwaway or the saved-from lease comes back.
        await expectNoFolderNamedAfter(strangers, first.deviceSet);

        // why: case 5, a baseline's copy swaps in under 1 s, so a fall back to a full read is caught.
        for (const copy of copies) {
          expect(await swapMilliseconds(env, copy.udid)).toBeLessThan(1000);
        }
      },
    );
  },
);
