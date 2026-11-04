import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultWorkerLockPath,
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

describe("defaultWorkerLockPath", () => {
  it.each([
    { platform: "darwin", expected: "/tmp/simlock-501/worker.lock" },
    { platform: "linux", expected: "/tmp/simlock-501/worker.lock" },
    { platform: "win32", expected: "C:\\Temp\\simlock\\worker.lock" },
  ] as const)("is $expected on $platform", ({ expected, platform }) => {
    expect(defaultWorkerLockPath(platform, 501, "C:\\Temp")).toBe(expected);
  });
});

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
    {
      holder: JSON.stringify({ folder: "/x", pid: 0, startedAt: "t" }),
      name: "an owner.json with pid 0, which the supervisor would call alive",
    },
    { holder: JSON.stringify({ pid: 7, startedAt: "t" }), name: "an owner.json without a folder" },
    { holder: undefined, name: "a lock folder without owner.json", bare: true },
  ])("takes the lock and writes the owner over $name", async ({ bare, holder }) => {
    const { path } = await lockInTemporaryFolder();
    if (holder !== undefined || bare === true) {
      await mkdir(path, { recursive: true });
    }
    if (holder !== undefined) await writeFile(join(path, "owner.json"), holder);

    await adapter(path, [0, -3]).take(ME);

    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(ME);
  });

  it("refuses a live holder in another folder with its details, and leaves a live holder in the same folder alone", async () => {
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

  it("a worker that wins the socket claim makes the lock again when it is missing and refuses when a live pid in another folder holds it", async () => {
    const { path } = await lockInTemporaryFolder();
    const handle = await adapter(path).take(ME);

    await rm(path, { force: true, recursive: true });
    await handle.claimed();
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(ME);

    const other: WorkerLockOwner = { folder: "/home/other/.simlock", pid: 7, startedAt: "t0" };
    await writeFile(join(path, "owner.json"), JSON.stringify(other));
    const refusing = await adapter(path, [7]).take({ ...ME, folder: other.folder });
    await writeFile(join(path, "owner.json"), JSON.stringify({ ...other, folder: "/elsewhere" }));
    await expect(refusing.claimed()).rejects.toThrow(
      "another Simlock worker runs for this user (pid 7, folder /elsewhere, since t0)",
    );
  });

  it.each([
    { order: "after the winner made the lock folder", hook: "mkdirp" },
    { order: "while the winner writes owner.json", hook: "write" },
    { order: "after the winner wrote owner.json", hook: "read-back" },
  ] as const)(
    "a start that lost the claim never removes the lock a winner makes its own when the loser releases $order",
    async ({ hook }) => {
      const { path } = await lockInTemporaryFolder();
      const winner: WorkerLockOwner = { ...ME, pid: 200, startedAt: "2026-11-02T09:00:01.000Z" };
      const winnerFilesystem = new NodeFilesystem();
      const winnerHandle = await new NodeWorkerLock({
        filesystem: winnerFilesystem,
        path,
        processSupervisor: new FakeProcessSupervisor([]),
        uid: process.getuid?.(),
      }).take(winner);
      const loserHandle = await adapter(path).take(ME);
      // why: the winner's claim cannot be scheduled between two calls of the loser's release, so the loser's whole release runs at the chosen point of the claim, once.
      let released = false;
      const loserRelease = async () => {
        if (released) return;
        released = true;
        await loserHandle.release();
      };
      const mkdirpOnce = winnerFilesystem.mkdirp.bind(winnerFilesystem);
      const writeOnce = winnerFilesystem.writeFileAtomic.bind(winnerFilesystem);
      const readOnce = winnerFilesystem.readFile.bind(winnerFilesystem);
      let wrote = false;
      winnerFilesystem.mkdirp = async (folder, options) => {
        await mkdirpOnce(folder, options);
        if (hook === "mkdirp") await loserRelease();
      };
      winnerFilesystem.writeFileAtomic = async (file, contents, options) => {
        if (hook === "write" && !released) {
          // why: the folder moves after the temporary file is written and before it is renamed, so the rename finds nothing, as the real one does.
          await loserRelease();
          throw Object.assign(new Error("ENOENT: rename"), { code: "ENOENT" });
        }
        await writeOnce(file, contents, options);
        wrote = true;
      };
      winnerFilesystem.readFile = async (file) => {
        if (hook === "read-back" && wrote && !released) await loserRelease();
        return readOnce(file);
      };

      await winnerHandle.claimed();

      expect(released).toBe(true);
      expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(winner);
      expect((await readdir(dirname(path))).filter((name) => name.includes(".release-"))).toEqual(
        [],
      );
      await winnerHandle.release();
      await expect(stat(path)).rejects.toThrow();
    },
  );

  it("a start that lost the claim never removes the lock a winner makes its own when the winner claims after the loser moved the lock away", async () => {
    const { path } = await lockInTemporaryFolder();
    const winner: WorkerLockOwner = { ...ME, pid: 200, startedAt: "2026-11-02T09:00:01.000Z" };
    const winnerHandle = await adapter(path).take(winner);
    const loserFilesystem = new NodeFilesystem();
    const loserHandle = await new NodeWorkerLock({
      filesystem: loserFilesystem,
      path,
      processSupervisor: new FakeProcessSupervisor([]),
      uid: process.getuid?.(),
    }).take(ME);
    // why: the winner's claim cannot be scheduled between two of the loser's calls, so it runs right after the loser's first read of owner.json.
    const readOnce = loserFilesystem.readFile.bind(loserFilesystem);
    let claimed = false;
    loserFilesystem.readFile = async (file: string) => {
      const contents = await readOnce(file);
      if (!claimed && file.endsWith("owner.json")) {
        claimed = true;
        await winnerHandle.claimed();
      }
      return contents;
    };

    await loserHandle.release();

    expect(claimed).toBe(true);
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toEqual(winner);
  });

  it.each([
    { alive: false, kept: false, name: "whose releasing process is gone" },
    { alive: true, kept: true, name: "whose releasing process is alive" },
  ])("a take clears a leftover .release folder $name", async ({ alive, kept }) => {
    const { path } = await lockInTemporaryFolder();
    await adapter(path)
      .take(ME)
      .then((handle) => handle.release());
    const aside = `${path}.release-4242-abc`;
    await mkdir(aside);

    await adapter(path, alive ? [4242] : []).take(ME);

    expect(
      await stat(aside).then(
        () => true,
        () => false,
      ),
    ).toBe(kept);
  });
});
