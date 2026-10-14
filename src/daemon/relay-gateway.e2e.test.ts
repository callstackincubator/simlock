import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeDriver } from "../core/testing.js";
import { GatewayRelay, type GatewayWorkerClient, type WorkerDirectory } from "../gateway/index.js";
import { MemoryFilesystem, NoopLogger, SystemClock, createConnectionPair } from "../ports/index.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { RelayTarget } from "./relay.js";
import type { DaemonServer } from "./server.js";
import {
  adminSession,
  aborted,
  cleanUp,
  digestOf,
  freeLoopbackPort,
  gate,
  MIB,
  KIB,
  patternBytes,
  patternDigest,
  patternStream,
  readAll,
  settle,
  sleep,
  startWorker,
  type WorkerFixture,
} from "./test-relay-support.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const poll = <T>(read: () => T | Promise<T>, timeout = 5_000) => expect.poll(read, { timeout });

type CallInit = {
  readonly target?: string;
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly body?: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
  readonly tenant?: string;
  readonly leaseId?: string;
};

const WORKER_ID = "wrk_a";

function buildCall(init: CallInit) {
  const request = new Request(init.url ?? "http://gateway.test:4321/agent-device/rpc?x=1&y=2", {
    method: init.method ?? "GET",
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body, duplex: "half" }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  } as RequestInit);
  return {
    request,
    target: init.target ?? "echo",
    tenant: init.tenant ?? "gw.g1.alice",
    ...(init.leaseId === undefined ? {} : { leaseId: init.leaseId }),
  };
}

interface ClientSpy {
  readonly events: string[];
  unanswered: number;
  maxUnanswered: number;
  bodyCalls: number;
}

function spyOn(client: GatewayWorkerClient): { client: GatewayWorkerClient; spy: ClientSpy } {
  const spy: ClientSpy = { bodyCalls: 0, events: [], maxUnanswered: 0, unanswered: 0 };
  const wrapHooks = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const hooks = { ...(value as Record<string, unknown>) };
    for (const name of ["onRelayHead", "onRelayChunk"]) {
      const original = hooks[name];
      if (typeof original === "function") {
        hooks[name] = (...args: unknown[]) => {
          spy.events.push(`push:${name}`);
          return (original as (...rest: unknown[]) => unknown)(...args);
        };
      }
    }
    return hooks;
  };
  const wrapped = new Proxy(client, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== "function") return original;
      const method = original as (...args: unknown[]) => Promise<unknown>;
      if (property === "relayRequest") {
        return async (...args: unknown[]) => {
          const value = await method.apply(target, args.map(wrapHooks));
          spy.events.push(`request-answered:${JSON.stringify(value)}`);
          return value;
        };
      }
      if (property === "relayBody") {
        return async (...args: unknown[]) => {
          spy.bodyCalls += 1;
          spy.unanswered += 1;
          spy.maxUnanswered = Math.max(spy.maxUnanswered, spy.unanswered);
          try {
            return await method.apply(target, args);
          } finally {
            spy.unanswered -= 1;
          }
        };
      }
      if (property === "relayCancel") {
        return async (...args: unknown[]) => {
          spy.events.push("cancel-sent");
          const value = await method.apply(target, args);
          spy.events.push("cancel-answered");
          return value;
        };
      }
      return method.bind(target);
    },
  });
  return { client: wrapped, spy };
}

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
    targetCalls.length = 0;
    await cleanUp(daemons, directories);
  });

  async function startPair(options: { readonly deadlineMs?: number } = {}) {
    const fixture: WorkerFixture = await startWorker(directories, daemons, {
      "agent-device": target,
      echo: target,
    });
    const [workerEnd, gatewayEnd] = createConnectionPair();
    fixture.worker.acceptUplink(workerEnd);
    const connected = (await connectSimlockClient(
      { connection: gatewayEnd, principal: "gw:test" },
      true,
    )) as GatewayWorkerClient;
    const { client, spy } = spyOn(connected);
    const directory: WorkerDirectory = {
      target: (workerId) =>
        workerId === WORKER_ID
          ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
          : undefined,
    };
    const relay = new GatewayRelay({
      directory,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    });
    return { fixture, gatewayEnd, relay, spy };
  }

  async function startFleet(execCommand?: { args: string[]; command: string; env: object }) {
    const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-relay-gateway-"));
    directories.push(gatewayDirectory);
    const port = await freeLoopbackPort();
    let relay: GatewayRelay | undefined;
    const gateway = await startDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      dataDirectory: gatewayDirectory,
      filesystem: new MemoryFilesystem(),
      gatewayRelay: (given) => {
        relay = given;
      },
      logger: new NoopLogger(),
      statePath: join(gatewayDirectory, "state.json"),
      version: "1.0.0-e2e",
    });
    daemons.push(gateway);
    const { secret } = await gateway.dispatch(
      "token.create",
      { label: "worker-a", role: "worker" },
      adminSession,
    );
    const driverOptions =
      execCommand === undefined
        ? {}
        : { passthrough: () => execCommand, passthroughTools: ["adb"] };
    const worker = await startWorker(
      directories,
      daemons,
      { "agent-device": target, echo: target },
      {
        configOverrides: {
          gateway: { label: "worker-a", token: secret, url: `ws://127.0.0.1:${String(port)}` },
        },
        drivers: [
          new FakeDriver({
            availableOsVersions: ["18.0"],
            clock: new SystemClock(),
            knownModels: ["Pixel-A"],
            platform: "android",
            ...driverOptions,
          } as ConstructorParameters<typeof FakeDriver>[0]),
        ],
      },
    );
    let workerId = "";
    await vi.waitFor(
      async () => {
        const { workers } = await gateway.dispatch("worker.list", {}, adminSession);
        const ready = workers.find(
          (view) => view.connection === "connected" && view.capacity && view.catalog?.length,
        );
        expect(ready).toBeDefined();
        workerId = ready?.id ?? "";
      },
      { timeout: 10_000 },
    );
    expect(relay).toBeDefined();
    return { gateway, relay: relay as unknown as GatewayRelay, worker, workerId };
  }

  const agent = (overrides: Partial<DispatchSession> = {}): DispatchSession => ({
    manageEventSubscription: () => undefined,
    principal: "fleet-agent-1",
    role: "agent",
    ...overrides,
  });

  it("a GET relayed to the fake target arrives with its URL (origin, path and query), method, headers, tenant and lease id, and its status, headers and body come back unchanged", async () => {
    behavior = () =>
      Promise.resolve(
        new Response("hello from the target", {
          headers: { "content-type": "text/plain", "x-reply": "yes" },
          status: 201,
        }),
      );
    const { relay, workerId } = await startFleet();

    const response = await relay.relay(
      workerId,
      buildCall({ headers: { accept: "text/plain", "x-test": "1" }, leaseId: "lease_1" }),
    );

    expect(targetCalls).toHaveLength(1);
    const seen = targetCalls[0];
    expect(seen?.url).toBe("http://gateway.test:4321/agent-device/rpc?x=1&y=2");
    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("accept")).toBe("text/plain");
    expect(seen?.headers.get("x-test")).toBe("1");
    expect(seen?.tenant).toBe("gw.g1.alice");
    expect(seen?.leaseId).toBe("lease_1");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-reply")).toBe("yes");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("hello from the target");
  }, 30_000);

  it("a 20 MiB PUT body arrives at the target byte for byte, and a 20 MiB response body comes back byte for byte", async () => {
    let received = "";
    behavior = async (request) => {
      received = digestOf(await readAll(request.body));
      return new Response(patternStream(20 * MIB, 9));
    };
    const { relay, workerId } = await startFleet();

    const response = await relay.relay(
      workerId,
      buildCall({ body: patternStream(20 * MIB, 5), method: "PUT" }),
    );
    const back = digestOf(await readAll(response.body));

    expect(received).toBe(patternDigest(20 * MIB, 5));
    expect(back).toBe(patternDigest(20 * MIB, 9));
  }, 120_000);

  it("while a 20 MiB relay runs, a lease.renew forwarded to the same worker answers", async () => {
    const midway = gate();
    let finished = false;
    behavior = async (request) => {
      const reader = request.body?.getReader();
      let total = 0;
      for (;;) {
        const step = await reader?.read();
        if (step === undefined || step.done) break;
        total += step.value.length;
        if (total >= 5 * MIB) midway.open();
      }
      finished = true;
      return new Response("done");
    };
    const { gateway, relay, workerId } = await startFleet();
    const grant = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", noWait: true, platform: "android" },
      agent(),
    );

    const pending = relay.relay(
      workerId,
      buildCall({ body: patternStream(20 * MIB, 5), method: "PUT" }),
    );
    await midway.promise;
    const renewed = await settle(
      gateway.dispatch("lease.renew", { leaseId: grant.lease.id }, agent()),
      10_000,
    );
    const relayFinishedBeforeRenew = finished;
    const response = await pending;

    expect(renewed).toMatchObject({ state: "fulfilled", value: { id: grant.lease.id } });
    expect(relayFinishedBeforeRenew).toBe(false);
    expect(await response.text()).toBe("done");
  }, 120_000);

  it("a relay and a device.exec with output running at once on one worker each get only their own pushes", async () => {
    const execStarted = gate();
    behavior = () => {
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              controller.enqueue(encoder.encode("r1"));
              await execStarted.promise;
              controller.enqueue(encoder.encode("r2"));
              controller.close();
            },
          }),
        ),
      );
    };
    const { gateway, relay, workerId } = await startFleet({
      args: ["-e", 'process.stdout.write("e1");setTimeout(()=>process.stdout.write("e2"),300);'],
      command: process.execPath,
      env: {},
    });
    const grant = await gateway.dispatch(
      "lease.request",
      { model: "Pixel-A", noWait: true, platform: "android" },
      agent(),
    );
    const output: string[] = [];

    const exec = gateway.dispatch(
      "device.exec",
      { args: [], leaseId: grant.lease.id, tool: "adb" },
      agent({
        onOutput: (_stream, chunk) => {
          output.push(chunk);
          execStarted.open();
        },
      }),
    );
    const response = await relay.relay(workerId, buildCall({}));
    const body = await response.text();
    await exec;

    expect(body).toBe("r1r2");
    expect(output.join("")).toBe("e1e2");
  }, 30_000);

  it("the gateway never has more than 4 relay.body calls unanswered, checked with a target that reads its body slowly", async () => {
    behavior = async (request) => {
      const reader = request.body?.getReader();
      for (;;) {
        const step = await reader?.read();
        if (step === undefined || step.done) break;
        await sleep(25);
      }
      return new Response("read it all");
    };
    const { relay, spy } = await startPair();

    const response = await relay.relay(
      WORKER_ID,
      buildCall({
        body: patternStream(12 * 256 * KIB, 2, { pieceSize: 256 * KIB }),
        method: "PUT",
      }),
    );
    await response.text();

    expect(spy.bodyCalls).toBeGreaterThan(4);
    expect(spy.maxUnanswered).toBeGreaterThanOrEqual(2);
    expect(spy.maxUnanswered).toBeLessThanOrEqual(4);
  }, 30_000);

  it("a target that answers 401 without reading its body: the caller gets the 401, every relay.body is answered, and the gateway stops reading the caller's body", async () => {
    behavior = async () => {
      // why: the 401 comes after the gateway has filled its window, so relay.body calls are pending when the relay settles
      await sleep(300);
      return new Response("nope", { status: 401 });
    };
    const { relay, spy } = await startPair();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        await sleep(5);
        controller.enqueue(patternBytes(256 * KIB, 4));
        if (pulls >= 100) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    const response = await relay.relay(WORKER_ID, buildCall({ body, method: "PUT" }));
    const text = await response.text();
    await sleep(300);
    const pullsAfterAnswer = pulls;
    await sleep(300);

    expect(response.status).toBe(401);
    expect(text).toBe("nope");
    expect(spy.maxUnanswered).toBeGreaterThanOrEqual(1);
    expect(pulls).toBe(pullsAfterAnswer);
    expect(pulls).toBeLessThan(100);
    expect(cancelled).toBe(true);
    expect(spy.unanswered).toBe(0);
  }, 30_000);

  it("a response the target streams in parts reaches the gateway caller part by part, before the target's body ends", async () => {
    const second = gate();
    behavior = () => {
      const encoder = new TextEncoder();
      let step = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              step += 1;
              if (step === 1) controller.enqueue(encoder.encode("part-1"));
              else {
                await second.promise;
                controller.enqueue(encoder.encode("part-2"));
                controller.close();
              }
            },
          }),
        ),
      );
    };
    const { relay } = await startPair();

    const response = await relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    const first = await settle(reader?.read() ?? Promise.reject(new Error("no body")), 3_000);
    second.open();
    const rest = await settle(reader?.read() ?? Promise.reject(new Error("no body")), 3_000);

    expect(
      first.state === "fulfilled" ? new TextDecoder().decode(first.value.value) : first.state,
    ).toBe("part-1");
    expect(
      rest.state === "fulfilled" ? new TextDecoder().decode(rest.value.value) : rest.state,
    ).toBe("part-2");
  }, 30_000);

  it.each([
    { method: "GET", status: 204 },
    { method: "GET", status: 205 },
    { method: "GET", status: 304 },
    { method: "HEAD", status: 200 },
  ])(
    "a $status answer to a $method reaches the caller with a null body",
    async ({ method, status }) => {
      behavior = () => Promise.resolve(new Response(method === "HEAD" ? "x" : null, { status }));
      const { relay } = await startPair();

      const response = await relay.relay(WORKER_ID, buildCall({ method }));

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    },
  );

  it("a caller that reads nothing while the target streams 80 MiB slowly gets its body stream errored, with a message saying the reader fell behind, once 64 MiB is buffered, and the target's request signal aborts before it has sent all 80 MiB", async () => {
    let sent = 0;
    let signal: AbortSignal | undefined;
    behavior = (request) => {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await sleep(20);
              controller.enqueue(patternBytes(MIB, 6, sent));
              sent += MIB;
              if (sent >= 80 * MIB) controller.close();
            },
          }),
        ),
      );
    };
    const { relay } = await startPair();

    const response = await relay.relay(WORKER_ID, buildCall({}));
    await poll(() => signal?.aborted, 15_000).toBe(true);
    const read = await settle(
      response.body?.getReader().read() ?? Promise.reject(new Error("no body")),
    );

    expect(sent).toBeLessThan(80 * MIB);
    expect(read).toMatchObject({ state: "rejected" });
    expect(read.state === "rejected" ? read.message : "").toMatch(/fell behind/);
  }, 60_000);

  it("aborting the caller's request signal before the head comes fails the call; after it, it errors the caller's body stream; either way the target's request signal aborts and relay.request answers { cancelled: true } with no push after the cancel", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const before = await startPair();
    const controller = new AbortController();
    const pendingBefore = before.relay.relay(WORKER_ID, buildCall({ signal: controller.signal }));
    const settledBefore = settle(pendingBefore);
    await poll(() => signal !== undefined).toBe(true);
    controller.abort(new Error("caller left before the head"));
    const failure = await settledBefore;
    await poll(() => signal?.aborted).toBe(true);
    await poll(() =>
      before.spy.events.filter((event) => event.startsWith("request-answered")),
    ).toEqual(['request-answered:{"cancelled":true}']);

    signal = undefined;
    behavior = (request) => {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(streamController) {
              await sleep(10);
              streamController.enqueue(patternBytes(512, 1));
            },
          }),
        ),
      );
    };
    const after = await startPair();
    const secondController = new AbortController();
    const response = await after.relay.relay(
      WORKER_ID,
      buildCall({ signal: secondController.signal }),
    );
    const reader = response.body?.getReader();
    await reader?.read();
    secondController.abort(new Error("caller left after the head"));
    const bodyFailure = await settle(
      (async () => {
        for (;;) {
          const step = await reader?.read();
          if (step === undefined || step.done) return;
        }
      })(),
    );
    await poll(() => signal?.aborted).toBe(true);
    await poll(() =>
      after.spy.events.filter((event) => event.startsWith("request-answered")),
    ).toEqual(['request-answered:{"cancelled":true}']);
    await sleep(150);
    const eventsAfterCancel = after.spy.events.slice(
      after.spy.events.indexOf("cancel-answered") + 1,
    );

    expect(failure).toMatchObject({ message: "caller left before the head", state: "rejected" });
    expect(bodyFailure).toMatchObject({ message: "caller left after the head", state: "rejected" });
    expect(after.spy.events).toContain("cancel-answered");
    expect(eventsAfterCancel.filter((event) => event.startsWith("push:"))).toEqual([]);
  }, 30_000);

  it("a caller's request body that errors mid-upload aborts the target's request signal", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await readAll(request.body).catch(() => undefined);
      await aborted(request.signal);
      return new Response("late");
    };
    const { relay } = await startPair();
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        step += 1;
        if (step === 1) controller.enqueue(patternBytes(1024, 8));
        else controller.error(new Error("upload broke"));
      },
    });

    const outcome = await settle(relay.relay(WORKER_ID, buildCall({ body, method: "PUT" })));

    expect(outcome).toMatchObject({ message: "upload broke", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("a target that never answers is cancelled after a 200 ms deadline, and the caller gets WORKER_UNREACHABLE with message `worker <id> did not finish the relayed request within 200 ms`; one that stalls after its head gets its body stream errored with that message", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const never = await startPair({ deadlineMs: 200 });
    const noHead = await settle(never.relay.relay(WORKER_ID, buildCall({})));
    await poll(() => signal?.aborted).toBe(true);

    behavior = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        ),
      );
    const stalling = await startPair({ deadlineMs: 200 });
    const response = await stalling.relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    await reader?.read();
    const stalled = await settle(reader?.read() ?? Promise.reject(new Error("no body")));

    const message = `worker ${WORKER_ID} did not finish the relayed request within 200 ms`;
    expect(noHead).toMatchObject({ code: "WORKER_UNREACHABLE", message, state: "rejected" });
    expect(stalled).toMatchObject({ message, state: "rejected" });
  }, 30_000);

  it("closing the uplink mid-relay fails the caller with WORKER_UNREACHABLE, or errors its body stream after the head, and aborts the target's request signal", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const before = await startPair();
    const noHead = settle(before.relay.relay(WORKER_ID, buildCall({})));
    await poll(() => signal !== undefined).toBe(true);
    await before.gatewayEnd.close();
    const noHeadOutcome = await noHead;
    await poll(() => signal?.aborted).toBe(true);

    signal = undefined;
    behavior = (request) => {
      signal = request.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        ),
      );
    };
    const after = await startPair();
    const response = await after.relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    await reader?.read();
    await after.gatewayEnd.close();
    const bodyOutcome = await settle(reader?.read() ?? Promise.reject(new Error("no body")));

    expect(noHeadOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(bodyOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("a relay to a worker with no uplink fails with WORKER_UNREACHABLE and the target sees nothing", async () => {
    const { relay } = await startPair();

    const outcome = await settle(relay.relay("wrk_nobody", buildCall({})));
    await sleep(100);

    expect(outcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(targetCalls).toEqual([]);
  });

  it("a relay naming a target nobody registered fails with RELAY_TARGET_MISSING", async () => {
    const { relay } = await startPair();

    const outcome = await settle(relay.relay(WORKER_ID, buildCall({ target: "nobody" })));

    expect(outcome).toMatchObject({ code: "RELAY_TARGET_MISSING", state: "rejected" });
    expect(targetCalls).toEqual([]);
  });

  it("the caller's authorization, x-agent-device-token, connection and transfer-encoding headers never reach the target, and a target's content-length and connection headers never reach the caller", async () => {
    behavior = () =>
      Promise.resolve(
        new Response("hello", {
          headers: { connection: "close", "content-length": "5", "x-kept": "yes" },
        }),
      );
    const { relay } = await startPair();

    const response = await relay.relay(
      WORKER_ID,
      buildCall({
        headers: {
          authorization: "Bearer gateway-secret",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "x-agent-device-token": "device-secret",
          "x-keep-me": "yes",
        },
      }),
    );
    await response.text();

    const seen = targetCalls[0]?.headers;
    expect(seen?.get("x-keep-me")).toBe("yes");
    expect(seen?.get("authorization")).toBeNull();
    expect(seen?.get("x-agent-device-token")).toBeNull();
    expect(seen?.get("connection")).toBeNull();
    expect(seen?.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
  });

  it("the gateway's 9th relay to one worker starts only after one of 8 ends", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    const { relay } = await startPair();

    const calls = Array.from({ length: 9 }, () =>
      settle(relay.relay(WORKER_ID, buildCall({})), 10_000),
    );
    await poll(() => targetCalls.length).toBe(8);
    await sleep(200);
    const startedBeforeRelease = targetCalls.length;
    release.open();
    const outcomes = await Promise.all(calls);

    expect(startedBeforeRelease).toBe(8);
    expect(targetCalls).toHaveLength(9);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(
      Array.from({ length: 9 }, () => "fulfilled"),
    );
  }, 30_000);
});
