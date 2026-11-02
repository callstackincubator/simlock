import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeProcessSupervisor,
  NodeFilesystem,
  NodeWorkerLock,
  type WorkerLockOwner,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const ME: WorkerLockOwner = {
  folder: "/home/me/.simlock",
  pid: 100,
  startedAt: "2026-11-02T09:00:00.000Z",
};

async function lockInTemporaryFolder() {
  const root = await mkdtemp(join(tmpdir(), "simlock-worker-lock-"));
  directories.push(root);
  return { path: join(root, "simlock-501", "worker.lock"), root };
}

function adapter(path: string, livePids: readonly number[] = [], uid = process.getuid?.()) {
  return new NodeWorkerLock({
    filesystem: new NodeFilesystem(),
    path,
    processSupervisor: new FakeProcessSupervisor(livePids),
    uid,
  });
}

describe("NodeWorkerLock", () => {
  it.each([
    { holder: undefined, name: "no lock" },
    {
      holder: JSON.stringify({ folder: "/x", pid: 7, startedAt: "t" }),
      name: "a holder whose pid is gone",
    },
    { holder: "not json {", name: "an owner.json that is not JSON" },
    {
      holder: JSON.stringify({ folder: "/x", pid: "7", startedAt: "t" }),
      name: "an owner.json with a pid that is not a number",
    },
    {
      holder: JSON.stringify({ folder: "/x", pid: -3, startedAt: "t" }),
      name: "an owner.json with a pid below 1",
    },
    { holder: JSON.stringify({ pid: 7, startedAt: "t" }), name: "an owner.json without a folder" },
    { holder: undefined, name: "a lock folder without owner.json", bare: true },
  ])("takes the lock and writes the owner over $name", async ({ bare, holder }) => {
    const { path } = await lockInTemporaryFolder();
    if (holder !== undefined || bare === true) {
      await mkdir(path, { recursive: true });
    }
    if (holder !== undefined) await writeFile(join(path, "owner.json"), holder);

    await adapter(path).take(ME);

    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(ME);
  });

  it("refuses a live holder in another folder and goes on, touching nothing, beside a live holder in the same folder", async () => {
    const { path } = await lockInTemporaryFolder();
    const holder: WorkerLockOwner = { folder: "/home/other/.simlock", pid: 7, startedAt: "t0" };
    await adapter(path).take(holder);

    await expect(adapter(path, [7]).take(ME)).rejects.toThrow(
      "another Simlock worker runs for this user (pid 7, folder /home/other/.simlock, since t0); stop it first: SIMLOCK_HOME=/home/other/.simlock simlock daemon stop",
    );
    const sameFolder = await adapter(path, [7]).take({ ...ME, folder: holder.folder });
    await sameFolder.release();

    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(holder);
  });

  it("refuses a parent folder owned by another user and tightens one of its own to 0700", async () => {
    const { path } = await lockInTemporaryFolder();
    const parent = dirname(path);
    await mkdir(parent, { mode: 0o755, recursive: true });
    await chmod(parent, 0o755);
    const uid = process.getuid?.() ?? 0;

    await expect(adapter(path, [], uid + 1).take(ME)).rejects.toThrow(
      `${parent} cannot be used as the worker lock folder: owned by another user`,
    );
    await adapter(path, [], uid).take(ME);

    expect((await stat(parent)).mode & 0o777).toBe(0o700);
  });
});
