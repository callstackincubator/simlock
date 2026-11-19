import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { createLeaseFiles } from "../lease-files/index.js";
import {
  CryptoIdGenerator,
  FakeClock,
  MemoryFilesystem,
  NodeFilesystem,
  NoopLogger,
} from "../ports/index.js";
import { start, runningDaemons } from "./test-main.js";

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test").catch(() => {})));
});

const admin = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
} as const;
const ios = { model: "iPhone 16", osVersion: "26.5", platform: "ios" } as const;

// why: a real daemon with HTTP on, a real data folder, and a lease its token holds, so lease end reaches the lease-files participant through the same path production uses.
async function rig() {
  const clock = new FakeClock(1_000);
  const drivers = [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })];
  const started = await start({
    clock,
    drivers,
    filesystem: new NodeFilesystem(),
    withHttp: true,
  });
  const { secret, token } = await started.daemon.dispatch(
    "token.create",
    { label: "holder", role: "agent" },
    admin,
  );
  const origin = `http://127.0.0.1:${String(started.port)}`;
  const headers = { authorization: `Bearer ${secret}` };
  const holder = {
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: token.id,
    role: "agent",
  } as const;
  const lease = async (): Promise<string> => {
    const grant = (await started.daemon.dispatch(
      "lease.request",
      { ...ios, requesterId: "agent-1" },
      holder,
    )) as { lease: { id: string } };
    return grant.lease.id;
  };
  const put = (id: string, name: string, body: BodyInit) =>
    fetch(`${origin}/v1/leases/${id}/files/${name}`, { body, headers, method: "PUT" });
  const list = (id: string) => fetch(`${origin}/v1/leases/${id}/files`, { headers });
  const release = (id: string) => started.daemon.dispatch("lease.release", { leaseId: id }, holder);
  const root = join(started.directory, "lease-files");
  const folders = () => readdir(root).catch(() => []);
  return { ...started, clock, drivers, folders, headers, lease, list, origin, put, release, root };
}

describe("a lease's files at lease end", () => {
  it("are gone once the lease is released, expires or is killed, and a new lease starts empty", async () => {
    const r = await rig();
    const ends: Record<string, (id: string) => Promise<unknown>> = {
      expired: () => {
        r.clock.advance(24 * 3_600_000);
        return new Promise((done) => setTimeout(done, 50));
      },
      killed: () => r.daemon.dispatch("nuke.run", { deleteDevices: true }, admin),
      released: (id) => r.release(id),
    };
    for (const [reason, end] of Object.entries(ends)) {
      const id = await r.lease();
      expect((await r.put(id, `${reason}.bin`, "bytes")).status, reason).toBe(201);
      expect(await r.folders(), reason).toHaveLength(1);

      await end(id);
      await new Promise((done) => setTimeout(done, 200));

      expect(await r.folders(), reason).toEqual([]);
      expect((await r.list(id)).status, reason).toBe(404);
    }
    const fresh = await r.lease();
    expect(await (await r.list(fresh)).json()).toEqual({ files: [] });
  });

  it("an upload still running when its lease ends answers 404 UNKNOWN_LEASE and leaves nothing behind", async () => {
    const r = await rig();
    const id = await r.lease();
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
        controller.enqueue(new TextEncoder().encode("first half"));
      },
    });
    const running = fetch(`${r.origin}/v1/leases/${id}/files/big.bin`, {
      body,
      duplex: "half",
      headers: r.headers,
      method: "PUT",
    } as RequestInit);
    await vi.waitFor(async () =>
      expect(await readdir(join(r.root, (await r.folders())[0] ?? ""))).toHaveLength(1),
    );

    await r.release(id);
    // why: the lease end stops the upload itself; it does not wait for the caller to finish sending.
    await vi.waitFor(async () => expect(await r.folders()).toEqual([]));
    feed.enqueue(new TextEncoder().encode("second half"));
    feed.close();
    const answer = await running;

    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "UNKNOWN_LEASE" } });
  });

  it("startup removes the folders of leases that are no longer live, an upload's temporary file included", async () => {
    const r = await rig();
    const live = await r.lease();
    await r.put(live, "kept.bin", "bytes");
    const [liveFolder = ""] = await r.folders();
    await writeFile(join(r.root, liveFolder, ".upload-left"), "half");
    const gone = join(r.root, `${Buffer.from("lse_gone").toString("hex")}-500`);
    await mkdir(gone, { recursive: true });
    await writeFile(join(gone, ".upload-x"), "half");
    await writeFile(join(gone, "old.bin"), "old");
    expect(await r.folders()).toHaveLength(2);

    await r.daemon.stop("test");
    runningDaemons.length = 0;
    const again = await start({
      clock: r.clock,
      dataDirectory: r.directory,
      drivers: r.drivers,
      filesystem: new NodeFilesystem(),
      withHttp: true,
    });

    expect(again.daemon).toBeDefined();
    expect(await r.folders()).toEqual([liveFolder]);
    expect(await readdir(join(r.root, liveFolder))).toEqual(["kept.bin"]);
  });
});

// why: the folder-level rules of `createLeaseFiles` that the worker's HTTP routes cannot force (`folderOf` is reached by exec, which has no held mkdir) or only by luck of timing: a held mkdir or listing, and grants whose lease ids differ only in case or in grant time.
class GatedFilesystem extends MemoryFilesystem {
  release: (() => void) | undefined;
  #gate: "mkdirp" | "readdir" | undefined;

  hold(call: "mkdirp" | "readdir"): void {
    this.#gate = call;
  }

  async #gated(call: "mkdirp" | "readdir"): Promise<void> {
    if (this.#gate !== call) return;
    this.#gate = undefined;
    await new Promise<void>((resolve) => (this.release = resolve));
  }

  override async mkdirp(path: string, options?: Parameters<MemoryFilesystem["mkdirp"]>[1]) {
    await this.#gated("mkdirp");
    return super.mkdirp(path, options);
  }

  // why: the first listing that shows a finished upload's temporary file is the one before the upload is renamed into place.
  override async readdir(path: string) {
    const names = await super.readdir(path);
    if (names.some((name) => name.startsWith(".upload-"))) await this.#gated("readdir");
    return names;
  }
}

function leaseFilesOver(filesystem: GatedFilesystem) {
  return createLeaseFiles({
    clock: new FakeClock(1_000),
    dataDirectory: "/data",
    diskPressureThreshold: 0,
    filesystem,
    findGrant: (id) => ({ grantedAt: 1, id, platform: "ios" }),
    idGenerator: new CryptoIdGenerator(),
    logger: new NoopLogger(),
  });
}

const grant = (id: string, grantedAt: number) => ({ grantedAt, id, platform: "ios" }) as const;
const ended = (id: string, grantedAt: number) =>
  ({
    deviceId: "dev-1",
    grantedAt,
    leaseId: id,
    ownerId: "agent-1",
    platform: "ios",
    reason: "explicit",
  }) as const;

describe("a lease's folder", () => {
  it("is removed with its own grant only: not a later grant of the same id, not an id that differs in case", async () => {
    const filesystem = new GatedFilesystem();
    const files = leaseFilesOver(filesystem);

    expect(await files.folderOf(grant("CI", 1))).toBe("/data/lease-files/4349-1");
    expect(await files.folderOf(grant("ci", 1))).toBe("/data/lease-files/6369-1");
    expect(await files.folderOf(grant("ci", 2))).toBe("/data/lease-files/6369-2");

    await files.leaseEnd.leaseEnded(ended("ci", 1), new AbortController().signal);

    expect(await filesystem.readdir("/data/lease-files")).toEqual(["4349-1", "6369-2"]);
  });

  it("a folderOf whose mkdir is still running when the lease ends leaves no folder, and a later folderOf is refused", async () => {
    const filesystem = new GatedFilesystem();
    const files = leaseFilesOver(filesystem);
    filesystem.hold("mkdirp");

    const making = files.folderOf(grant("ci", 1));
    await vi.waitFor(() => expect(filesystem.release).toBeDefined());
    const ending = files.leaseEnd.leaseEnded(ended("ci", 1), new AbortController().signal);
    filesystem.release?.();
    await ending;

    await making;
    expect(await filesystem.readdir("/data/lease-files")).toEqual([]);
    await expect(files.folderOf(grant("ci", 1))).rejects.toMatchObject({ code: "UNKNOWN_LEASE" });
  });

  it("an upload whose body is in but whose name is not yet taken when the lease ends answers 404 UNKNOWN_LEASE and leaves no folder", async () => {
    const filesystem = new GatedFilesystem();
    const files = leaseFilesOver(filesystem);
    filesystem.hold("readdir");

    const uploading = files.handle(
      new Request("http://worker/v1/leases/ci/files/a.bin", { body: "bytes", method: "PUT" }),
      { ambient: false, name: "agent", principal: "agent-1", role: "agent", via: "token" },
      { deviceId: "dev-1", id: "ci" },
      "a.bin",
    );
    await vi.waitFor(() => expect(filesystem.release).toBeDefined());
    const ending = files.leaseEnd.leaseEnded(ended("ci", 1), new AbortController().signal);
    filesystem.release?.();
    await ending;

    const answer = await uploading;
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "UNKNOWN_LEASE" } });
    expect(await filesystem.readdir("/data/lease-files")).toEqual([]);
  });
});
