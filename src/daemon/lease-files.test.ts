import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { FakeClock, NodeFilesystem } from "../ports/index.js";
import { freeLoopbackPort } from "./test-relay-support.js";
import { start, runningDaemons, temporaryDirectories } from "./test-main.js";

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
  const port = await freeLoopbackPort();
  const started = await start({
    clock,
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    filesystem: new NodeFilesystem(),
  });
  const { secret, token } = await started.daemon.dispatch(
    "token.create",
    { label: "holder", role: "agent" },
    admin,
  );
  const origin = `http://127.0.0.1:${String(port)}`;
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
  return { ...started, clock, folders, headers, lease, list, origin, put, release, root };
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
    feed.enqueue(new TextEncoder().encode("second half"));
    feed.close();
    const answer = await running;

    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: "UNKNOWN_LEASE" } });
    await vi.waitFor(async () => expect(await r.folders()).toEqual([]));
  });

  it("startup removes the folders of leases that are no longer live, an upload's temporary file included", async () => {
    const r = await rig();
    const live = await r.lease();
    await r.put(live, "kept.bin", "bytes");
    const gone = join(r.root, `${Buffer.from("lse_gone").toString("hex")}-500`);
    await mkdir(gone, { recursive: true });
    await writeFile(join(gone, ".upload-x"), "half");
    await writeFile(join(gone, "old.bin"), "old");
    expect(await r.folders()).toHaveLength(2);

    await r.daemon.stop("test");
    runningDaemons.length = 0;
    const again = await start({
      clock: r.clock,
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      dataDirectory: r.directory,
      filesystem: new NodeFilesystem(),
    }).catch(() => undefined);

    expect(again).toBeDefined();
    expect(temporaryDirectories.length).toBeGreaterThan(0);
    expect(await r.folders()).toEqual([]);
  });
});
