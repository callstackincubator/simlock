import { request as httpRequest } from "node:http";
import { readdir } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { LeaseFilesLimits } from "../lease-files/index.js";
import { TYPE } from "../link/testing.js";
import type { DispatchSession } from "./dispatch.js";
import type { RelayTarget, TwoWayRelayTarget } from "./relay.js";
import type { StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import {
  relayAdminSession,
  cleanUp,
  digestOf,
  MIB,
  KIB,
  patternBytes,
  patternDigest,
  patternStream,
  readParts,
  settleWithin,
  sleep,
  startFleet as startFleet_,
  type FleetExec,
} from "./test-relay-support.js";
import { buildCall } from "./test-relay-gateway.js";

const poll = <T>(read: () => T | Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

describe("a gateway relaying to a worker", { timeout: 15_000 }, () => {
  const daemons: DaemonServer[] = [];

  const directories: string[] = [];

  let behavior: RelayTarget = () => Promise.resolve(new Response("ok"));

  const targetCalls: {
    url: string;
    method: string;
    headers: Headers;
    tenant: string;
    leaseId: string | undefined;
  }[] = [];

  let twoWayBehavior: TwoWayRelayTarget = () =>
    Promise.resolve(new Response(null, { status: 200 }));

  const twoWayTarget: TwoWayRelayTarget = (request, tenant, leaseId, pipe) =>
    twoWayBehavior(request, tenant, leaseId, pipe);

  const target: RelayTarget = (request, tenant, leaseId) => {
    targetCalls.push({
      headers: request.headers,
      leaseId,
      method: request.method,
      tenant,
      url: request.url,
    });
    return behavior(request, tenant, leaseId);
  };

  afterEach(async () => {
    behavior = () => Promise.resolve(new Response("ok"));
    twoWayBehavior = () => Promise.resolve(new Response(null, { status: 200 }));
    targetCalls.length = 0;
    await cleanUp(daemons, directories);
  });

  const startFleet = (
    execCommand?: FleetExec,
    extra: {
      readonly proxyAuth?: Record<string, unknown>;
      readonly worker?: Partial<StartDaemonOptions>;
      readonly gateway?: Partial<StartDaemonOptions>;
    } = {},
  ) =>
    startFleet_(
      { daemons, directories, target, twoWayTarget },
      { ...(execCommand === undefined ? {} : { execCommand }), ...extra },
    );

  const agent = (overrides: Partial<DispatchSession> = {}): DispatchSession => ({
    manageEventSubscription: () => undefined,
    via: "socket",
    principal: "fleet-agent-1",
    role: "agent",
    ...overrides,
  });

  async function fileRig(limits?: LeaseFilesLimits, fileSilenceMs?: number) {
    const fleet = await startFleet(undefined, {
      ...(limits === undefined ? {} : { worker: { leaseFilesLimits: limits } }),
      ...(fileSilenceMs === undefined ? {} : { gateway: { fileSilenceMs } }),
    });
    const { secret, token } = await fleet.gateway.dispatch(
      "token.create",
      { label: "holder", role: "agent" },
      relayAdminSession,
    );
    const holder = agent({ principal: token.id });
    const grant = await fleet.gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", noWait: true, platform: "android" },
      holder,
    );
    const callOn =
      (leaseId: string, bearer: string) =>
      (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${String(fleet.port)}/v1/leases/${leaseId}/files${path}`, {
          ...init,
          headers: { authorization: `Bearer ${bearer}`, ...init.headers },
        });
    const call = callOn(grant.lease.id, secret);
    const base = `http://127.0.0.1:${String(fleet.port)}/v1/leases/${grant.lease.id}/files`;
    // why: `fetch` refuses a `Content-Length` that does not match its body, and the 2 GiB refusal is decided on the header alone.
    const declare = (path: string, bytes: number) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          `${base}${path}`,
          {
            headers: { authorization: `Bearer ${secret}`, "content-length": String(bytes) },
            method: "PUT",
          },
          (response) => {
            const parts: Buffer[] = [];
            response.on("data", (part: Buffer) => parts.push(part));
            response.on("end", () =>
              resolve({
                body: Buffer.concat(parts).toString(),
                status: response.statusCode ?? 0,
              }),
            );
          },
        );
        request.on("error", reject);
        // why: a gateway that waits for the body instead of refusing the header must fail the assertion, not the test's timeout.
        request.setTimeout(5_000, () => {
          request.destroy();
          resolve({ body: "no answer within 5 s", status: 0 });
        });
        request.flushHeaders();
      });
    const channelsOpened = () => fleet.taps.flatMap((tap) => tap.binaries(TYPE.OPEN)).length;
    // why: CI saw NO_CAPACITY for a request right after the release, so the helper retries until the fleet can grant.
    const newLease = async () => {
      let granted: string | undefined;
      await poll(async () => {
        granted = await fleet.gateway
          .dispatch(
            "lease.request",
            { model: "Pixel-A", noWait: true, platform: "android" },
            holder,
          )
          .then(
            (next) => next.lease.id,
            () => undefined,
          );
        return granted !== undefined;
      }, 15_000).toBe(true);
      const leaseId = granted as string;
      return { call: callOn(leaseId, secret), leaseId };
    };
    const stranger = async () => {
      const other = await fleet.gateway.dispatch(
        "token.create",
        { label: "stranger", role: "agent" },
        relayAdminSession,
      );
      return callOn(grant.lease.id, other.secret);
    };
    return {
      ...fleet,
      call,
      channelsOpened,
      declare,
      holder,
      leaseId: grant.lease.id,
      newLease,
      secret,
      stranger,
    };
  }

  // why: a loaded machine can hand a request to the worker late; holding a connection's bytes back makes the upload reach the worker late, so the test must wait for it before it probes the name.
  async function lateProxy(port: number, holdMs: number) {
    const sockets = new Set<{ destroy: () => void }>();
    const server = createServer((client) => {
      sockets.add(client);
      client.pause();
      setTimeout(() => {
        const upstream = connect(port, "127.0.0.1");
        sockets.add(upstream);
        client.pipe(upstream).pipe(client);
        client.resume();
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
      }, holdMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        }),
    );
    return (server.address() as { port: number }).port;
  }

  // why: `feed.write` resolving only means fetch took the first byte; the worker's store holds the name once its `.upload-<id>` file exists.
  async function uploadsOnWorker(directory: string) {
    const root = join(directory, "lease-files");
    const folders = await readdir(root).catch(() => []);
    const entries = await Promise.all(folders.map((folder) => readdir(join(root, folder))));
    return entries.flat().filter((entry) => entry.startsWith(".upload-")).length;
  }

  it("through a gateway, a lease holder's PUT, GET, list and DELETE reach the lease's worker and answer as on a worker", async () => {
    const { call, channelsOpened, declare } = await fileRig({
      fileBytes: 32 * MIB,
      leaseBytes: 512 * MIB,
      silenceMs: 330_000,
    });
    const bytes = patternBytes(20 * MIB, 5);

    const put = await call("/fixture.tar", {
      body: patternStream(20 * MIB, 5),
      duplex: "half",
      method: "PUT",
    } as RequestInit);
    const get = await call("/fixture.tar");
    const ranged = await call("/fixture.tar", { headers: { range: "bytes=10-19" } });
    const listed = await call("");
    const deleted = await call("/fixture.tar", { method: "DELETE" });
    const after = await call("");
    const names = Array.from({ length: 10 }, (_, index) => `many-${String(index)}.bin`);
    const many = await Promise.all(
      names.map((name, index) =>
        call(`/${name}`, {
          body: patternStream(20 * MIB, 20 + index),
          duplex: "half",
          method: "PUT",
        } as RequestInit),
      ),
    );
    const stored = await (await call("")).json();
    const missing = await call("/missing.bin");
    const oversized = await call("/large.bin", {
      body: patternStream(33 * MIB, 6),
      duplex: "half",
      method: "PUT",
    } as RequestInit);
    const opened = channelsOpened();
    const tooLarge = await declare("/huge.bin", 2 * 1024 * MIB + 1);

    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ name: "fixture.tar", size: 20 * MIB });
    expect(get.status).toBe(200);
    expect(digestOf([new Uint8Array(await get.arrayBuffer())])).toBe(digestOf([bytes]));
    expect(get.headers.get("content-length")).toBe(String(20 * MIB));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-length")).toBe("10");
    expect(ranged.headers.get("content-range")).toBe(`bytes 10-19/${String(20 * MIB)}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.subarray(10, 20));
    expect(await listed.json()).toMatchObject({ files: [{ name: "fixture.tar", size: 20 * MIB }] });
    expect(deleted.status).toBe(204);
    expect(await after.json()).toEqual({ files: [] });
    expect(many.map((response) => response.status)).toEqual(names.map(() => 201));
    expect(stored).toMatchObject({ files: names.map((name) => ({ name, size: 20 * MIB })) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "UNKNOWN_FILE" } });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "FILE_TOO_LARGE", name: "large.bin" },
    });
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toMatchObject({
      error: { code: "FILE_TOO_LARGE", name: "huge.bin" },
    });
    expect(channelsOpened()).toBe(opened);
  }, 120_000);

  it("through a gateway, a PUT of a name whose upload is still arriving gets 409 FILE_BUSY, once that upload has reached the worker late and is still arriving", async () => {
    const rig = await fileRig({ fileBytes: 32 * MIB, leaseBytes: 512 * MIB, silenceMs: 330_000 });
    const late = await lateProxy(rig.port, 500);
    const busy = new TransformStream<Uint8Array>();
    const holding = fetch(
      `http://127.0.0.1:${String(late)}/v1/leases/${rig.leaseId}/files/busy.bin`,
      {
        body: busy.readable,
        duplex: "half",
        headers: { authorization: `Bearer ${rig.secret}` },
        method: "PUT",
      } as RequestInit,
    );
    const feed = busy.writable.getWriter();
    await feed.write(new Uint8Array(1));
    await poll(() => uploadsOnWorker(rig.worker.directory)).toBe(1);

    const second = await rig.call("/busy.bin", { body: "x", method: "PUT" });
    await feed.close();
    const first = await holding;

    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "FILE_BUSY", name: "busy.bin" } });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ name: "busy.bin", size: 1 });
  }, 30_000);

  it("through a gateway, a caller that does not hold the lease gets 404 UNKNOWN_LEASE, and a lease whose worker is gone gets 503 WORKER_UNREACHABLE", async () => {
    const rig = await fileRig({ fileBytes: 32 * MIB, leaseBytes: MIB, silenceMs: 330_000 });
    const asStranger = await rig.stranger();
    const routes = (call: typeof rig.call) => [
      () => call("/fixture.tar", { body: "x", method: "PUT" }),
      () => call("/fixture.tar"),
      () => call("/fixture.tar", { method: "DELETE" }),
      () => call(""),
    ];

    const refused = await Promise.all(routes(asStranger).map((send) => send()));
    const full = await rig.call("/big.bin", { body: new Uint8Array(MIB + 1), method: "PUT" });
    const feed = new TransformStream<Uint8Array>();
    const writer = feed.writable.getWriter();
    const running = rig.call("/running.bin", {
      body: feed.readable,
      duplex: "half",
      method: "PUT",
    } as RequestInit);
    await writer.write(new Uint8Array(1));
    await poll(async () => (await rig.call("")).status).toBe(200);
    await rig.gateway.dispatch("lease.release", { leaseId: rig.leaseId }, rig.holder);
    await writer.write(new Uint8Array(1));
    await writer.close();
    const ended = await running;
    const next = await rig.newLease();
    await rig.worker.worker.stop("test");
    await poll(async () => (await next.call("")).status).toBe(503);

    expect(refused.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    for (const response of refused) {
      expect(await response.json()).toMatchObject({
        error: { code: "UNKNOWN_LEASE", leaseId: rig.leaseId },
      });
    }
    expect(full.status).toBe(413);
    const fullBody = (await full.json()) as {
      error: { code: string; message: string; leaseId: string };
    };
    expect(fullBody.error).toMatchObject({ code: "LEASE_FILES_FULL", leaseId: rig.leaseId });
    expect(fullBody.error.message).toContain(`Lease ${rig.leaseId} holds`);
    expect(ended.status).toBe(404);
    const endedBody = (await ended.json()) as {
      error: { code: string; message: string; leaseId: string };
    };
    expect(endedBody.error).toMatchObject({ code: "UNKNOWN_LEASE", leaseId: rig.leaseId });
    expect(endedBody.error.message).toBe(`Unknown lease: ${rig.leaseId}`);
    expect(await (await next.call("")).json()).toMatchObject({
      error: { code: "WORKER_UNREACHABLE" },
    });
  }, 60_000);

  it("through a gateway, a file upload is cut only by 330 s of silence, not by 330 s in total", async () => {
    const { call } = await fileRig(undefined, 1_000);
    const pieces = 12;
    let sent = 0;
    const flowing = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await sleep(300);
        controller.enqueue(new Uint8Array(KIB));
        sent += 1;
        if (sent === pieces) controller.close();
      },
    });
    const silent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(KIB));
      },
    });

    const slow = await call("/slow.bin", {
      body: flowing,
      duplex: "half",
      method: "PUT",
    } as RequestInit);
    const stalled = await settleWithin(
      call("/stalled.bin", { body: silent, duplex: "half", method: "PUT" } as RequestInit),
      6_000,
    );

    expect(slow.status).toBe(201);
    expect(await slow.json()).toEqual({ name: "slow.bin", size: pieces * KIB });
    expect(stalled).toMatchObject({ state: "fulfilled", value: { status: 408 } });
    const body = await (stalled as { value: Response }).value.json();
    expect(body).toEqual({
      error: {
        code: "UPLOAD_STALLED",
        message: "No bytes of stalled.bin arrived for 1 s",
        name: "stalled.bin",
      },
    });
    expect((await (await call("")).json()) as { files: { name: string }[] }).toEqual({
      files: [{ name: "slow.bin", size: pieces * KIB }],
    });
  }, 30_000);

  it("a 20 MiB PUT body arrives at the target byte for byte, and a 20 MiB response body comes back byte for byte", async () => {
    let received = "";
    behavior = async (request) => {
      received = digestOf(await readParts(request.body));
      return new Response(patternStream(20 * MIB, 9));
    };
    const { relay, taps, workerId } = await startFleet();

    const response = await relay.relay(
      workerId,
      buildCall({ body: patternStream(20 * MIB, 5), method: "PUT" }),
    );
    const back = digestOf(await readParts(response.body));
    const dataBytes = taps
      .flatMap((tap) => tap.binaries(TYPE.DATA))
      .reduce((total, envelope) => total + envelope.payload.length, 0);

    expect(received).toBe(patternDigest(20 * MIB, 5));
    expect(back).toBe(patternDigest(20 * MIB, 9));
    expect(dataBytes).toBeGreaterThanOrEqual(20 * MIB);
  }, 120_000);

  it("an empty upload (0 bytes) reaches the target as an empty body, and a GET relays as before", async () => {
    const lengths: number[] = [];
    behavior = async (request) => {
      lengths.push((await request.arrayBuffer()).byteLength);
      return new Response("fine");
    };
    const { relay, workerId } = await startFleet();

    const put = await relay.relay(
      workerId,
      buildCall({ body: patternStream(0, 1), method: "PUT" }),
    );
    const get = await relay.relay(workerId, buildCall({}));

    expect(await put.text()).toBe("fine");
    expect(await get.text()).toBe("fine");
    expect(lengths).toEqual([0, 0]);
  }, 30_000);
});
