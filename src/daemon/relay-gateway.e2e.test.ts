import { afterEach, describe, expect, it } from "vitest";

import { GatewayRelay, type GatewayWorkerClient, type WorkerDirectory } from "../gateway/index.js";
import { linkPair, TYPE } from "../link/testing.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import type { DispatchSession } from "./dispatch.js";
import type { RelayTarget } from "./relay.js";
import type { DaemonServer } from "./server.js";
import {
  aborted,
  cleanUp,
  digestOf,
  gate,
  MIB,
  KIB,
  patternBytes,
  patternDigest,
  patternStream,
  readParts,
  settleWithin,
  sleep,
  startFleet as startFleet_,
  startWorker,
  type FleetExec,
  type WorkerFixture,
} from "./test-relay-support.js";

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
}

function spyOn(client: GatewayWorkerClient): { client: GatewayWorkerClient; spy: ClientSpy } {
  const spy: ClientSpy = { events: [] };
  const wrapHooks = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const hooks = { ...(value as Record<string, unknown>) };
    const original = hooks.onRelayHead;
    if (typeof original === "function") {
      hooks.onRelayHead = (...args: unknown[]) => {
        spy.events.push("push:onRelayHead");
        return (original as (...rest: unknown[]) => unknown)(...args);
      };
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

  async function startPair(
    options: { readonly deadlineMs?: number; readonly idleMs?: number } = {},
  ) {
    const fixture: WorkerFixture = await startWorker(directories, daemons, {
      "agent-device": target,
      echo: target,
    });
    const pair = linkPair();
    const gatewayEnd = pair.gatewayEnd;
    fixture.worker.acceptUplink(pair.worker);
    const connected = (await connectSimlockClient(
      { connection: pair.gateway, principal: "gw:test" },
      true,
    )) as GatewayWorkerClient;
    const { client, spy } = spyOn(connected);
    const directory: WorkerDirectory = {
      target: (workerId) =>
        workerId === WORKER_ID
          ? { client: () => client, reachable: true, refresh: async () => undefined, workerId }
          : undefined,
    };
    const makeRelay = (
      relayOptions: { readonly deadlineMs?: number; readonly idleMs?: number } = {},
    ) =>
      new GatewayRelay({
        directory,
        ...(relayOptions.deadlineMs === undefined ? {} : { deadlineMs: relayOptions.deadlineMs }),
        ...(relayOptions.idleMs === undefined ? {} : { idleMs: relayOptions.idleMs }),
      });
    const relay = makeRelay(options);
    const opened = () => pair.gatewayTap.binaries(TYPE.OPEN).length;
    return { fixture, gatewayEnd, makeRelay, opened, pair, relay, spy };
  }

  const startFleet = (execCommand?: FleetExec) =>
    startFleet_({ daemons, directories, target }, execCommand === undefined ? {} : { execCommand });

  const agent = (overrides: Partial<DispatchSession> = {}): DispatchSession => ({
    manageEventSubscription: () => undefined,
    via: "socket",
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

  it("through startFleet, a relayed GET opens a channel on the link between the gateway and the worker", async () => {
    behavior = () => Promise.resolve(new Response("over a channel"));
    const { relay, taps, workerId } = await startFleet();

    const response = await relay.relay(workerId, buildCall({}));
    const body = await response.text();

    expect(body).toBe("over a channel");
    expect(taps.flatMap((tap) => tap.binaries(TYPE.OPEN)).length).toBeGreaterThanOrEqual(1);
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
    const renewed = await settleWithin(
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

  it("a target that answers 401 without reading its 20 MiB upload: the caller gets the 401 and its body, and the gateway stops reading the caller's body", async () => {
    behavior = async () => {
      // why: the 401 comes after the upload has begun, so the gateway is reading the caller's body when the target answers
      await sleep(300);
      return new Response("nope", { status: 401 });
    };
    const { relay } = await startPair();
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
    expect(pulls).toBe(pullsAfterAnswer);
    expect(pulls).toBeLessThan(100);
    expect(cancelled).toBe(true);
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
    const first = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")), 3_000);
    second.open();
    const rest = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")), 3_000);

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

  it("a caller that reads nothing slows only its own transfer: another relay to the same worker completes while the first's response is unread, and the target has not sent all 80 MiB", async () => {
    let sent = 0;
    behavior = (request) => {
      if (new URL(request.url).searchParams.get("slow") === null) {
        return Promise.resolve(new Response("quick"));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await sleep(5);
              controller.enqueue(patternBytes(MIB, 6, sent));
              sent += MIB;
              if (sent >= 80 * MIB) controller.close();
            },
          }),
        ),
      );
    };
    const { relay } = await startPair();

    const slow = await relay.relay(
      WORKER_ID,
      buildCall({ url: "http://gateway.test:4321/agent-device/rpc?slow=1" }),
    );
    await sleep(500);
    const quick = await settleWithin(
      relay.relay(WORKER_ID, buildCall({})).then((response) => response.text()),
      5_000,
    );

    expect(quick).toEqual({ state: "fulfilled", value: "quick" });
    expect(sent).toBeLessThan(80 * MIB);
    expect(slow.status).toBe(200);
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
    const settledBefore = settleWithin(pendingBefore);
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
    const bodyFailure = await settleWithin(
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
      await readParts(request.body).catch(() => undefined);
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

    const outcome = await settleWithin(relay.relay(WORKER_ID, buildCall({ body, method: "PUT" })));

    expect(outcome).toMatchObject({ message: "upload broke", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("a target that never answers is cancelled after a 200 ms deadline, and the caller gets WORKER_UNREACHABLE with message `worker <id> did not finish the relayed request within 200 ms`; one that stalls after its head, under a 10 s deadline and a 200 ms idle bound, gets its body stream errored with WORKER_UNREACHABLE `worker <id> sent nothing on the relayed response for 200 ms`", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const never = await startPair({ deadlineMs: 200 });
    const noHead = await settleWithin(never.relay.relay(WORKER_ID, buildCall({})));
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
    const stalling = await startPair({ deadlineMs: 10_000, idleMs: 200 });
    const response = await stalling.relay.relay(WORKER_ID, buildCall({}));
    const reader = response.body?.getReader();
    await reader?.read();
    const stalled = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")));

    const message = `worker ${WORKER_ID} did not finish the relayed request within 200 ms`;
    expect(noHead).toMatchObject({ code: "WORKER_UNREACHABLE", message, state: "rejected" });
    expect(stalled).toMatchObject({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} sent nothing on the relayed response for 200 ms`,
      state: "rejected",
    });
  }, 30_000);

  it("closing the uplink mid-relay fails the caller with WORKER_UNREACHABLE, or errors its body stream after the head, and aborts the target's request signal", async () => {
    let signal: AbortSignal | undefined;
    behavior = async (request) => {
      signal = request.signal;
      await aborted(request.signal);
      return new Response("late");
    };
    const before = await startPair();
    const noHead = settleWithin(before.relay.relay(WORKER_ID, buildCall({})));
    await poll(() => signal !== undefined).toBe(true);
    await before.pair.gatewayEnd.close();
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
    await after.pair.gatewayEnd.close();
    const bodyOutcome = await settleWithin(reader?.read() ?? Promise.reject(new Error("no body")));

    expect(noHeadOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(bodyOutcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    await poll(() => signal?.aborted).toBe(true);
  }, 30_000);

  it("a relay to a worker with no uplink fails with WORKER_UNREACHABLE and the target sees nothing", async () => {
    const { relay } = await startPair();

    const outcome = await settleWithin(relay.relay("wrk_nobody", buildCall({})));
    await sleep(100);

    expect(outcome).toMatchObject({ code: "WORKER_UNREACHABLE", state: "rejected" });
    expect(targetCalls).toEqual([]);
  });

  it("a relay naming a target nobody registered fails with RELAY_TARGET_MISSING", async () => {
    const { relay } = await startPair();

    const outcome = await settleWithin(relay.relay(WORKER_ID, buildCall({ target: "nobody" })));

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

  it("a 65th relay to one worker starts once one of 64 ends, and not before", async () => {
    const releases: (() => void)[] = [];
    behavior = async () => {
      const held = gate();
      releases.push(held.open);
      await held.promise;
      return new Response("ok");
    };
    const { opened, relay } = await startPair();

    const calls = Array.from({ length: 65 }, () =>
      settleWithin(relay.relay(WORKER_ID, buildCall({})), 20_000),
    );
    await poll(() => targetCalls.length, 10_000).toBe(64);
    await sleep(200);
    const startedBeforeRelease = targetCalls.length;
    releases[0]?.();
    await poll(() => targetCalls.length, 10_000).toBe(65);
    for (const release of releases) release();
    const outcomes = await Promise.all(calls);

    expect(startedBeforeRelease).toBe(64);
    expect(opened()).toBe(65);
    expect(outcomes.map((outcome) => outcome.state)).toEqual(
      Array.from({ length: 65 }, () => "fulfilled"),
    );
  }, 60_000);

  it("a 65th relay whose 200 ms deadline passes first fails WORKER_UNREACHABLE with the deadline message, and its target is never called", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    const { makeRelay } = await startPair();
    const long = makeRelay();
    const short = makeRelay({ deadlineMs: 200 });
    const holders = Array.from({ length: 64 }, () =>
      settleWithin(long.relay(WORKER_ID, buildCall({})), 20_000),
    );
    await poll(() => targetCalls.length, 10_000).toBe(64);

    const outcome = await settleWithin(short.relay(WORKER_ID, buildCall({})));
    release.open();
    await Promise.all(holders);

    expect(outcome).toEqual({
      code: "WORKER_UNREACHABLE",
      message: `worker ${WORKER_ID} did not finish the relayed request within 200 ms`,
      state: "rejected",
    });
    expect(targetCalls).toHaveLength(64);
  }, 60_000);

  it("a 65th relay whose caller aborts while it waits for a channel fails at once with the abort reason", async () => {
    const release = gate();
    behavior = async () => {
      await release.promise;
      return new Response("ok");
    };
    const { relay } = await startPair();
    const holders = Array.from({ length: 64 }, () =>
      settleWithin(relay.relay(WORKER_ID, buildCall({})), 20_000),
    );
    await poll(() => targetCalls.length, 10_000).toBe(64);
    const controller = new AbortController();
    const waiting = settleWithin(
      relay.relay(WORKER_ID, buildCall({ signal: controller.signal })),
      3_000,
    );
    await sleep(100);

    controller.abort(new Error("caller left while waiting"));
    const outcome = await waiting;
    release.open();
    await Promise.all(holders);

    expect(outcome).toMatchObject({ message: "caller left while waiting", state: "rejected" });
    expect(targetCalls).toHaveLength(64);
  }, 60_000);

  const leaving: readonly {
    readonly name: string;
    readonly run: (
      relay: GatewayRelay,
      makeRelay: (o?: { deadlineMs?: number }) => GatewayRelay,
    ) => Promise<unknown>;
  }[] = [
    {
      name: "were cancelled",
      run: async (relay) => {
        const controller = new AbortController();
        const pending = settleWithin(
          relay.relay(WORKER_ID, buildCall({ signal: controller.signal })),
        );
        await sleep(20);
        controller.abort(new Error("cancelled"));
        return pending;
      },
    },
    {
      name: "timed out",
      run: (_relay, makeRelay) =>
        settleWithin(makeRelay({ deadlineMs: 100 }).relay(WORKER_ID, buildCall({}))),
    },
    {
      name: "failed with a missing target",
      run: (relay) => settleWithin(relay.relay(WORKER_ID, buildCall({ target: "nobody" }))),
    },
    {
      name: "had a target that answered without reading its upload",
      run: async (relay) => {
        const response = await relay.relay(
          WORKER_ID,
          buildCall({ body: patternStream(MIB, 3), method: "PUT" }),
        );
        return settleWithin(response.text());
      },
    },
  ];

  it.each(leaving)(
    "after 64 relays to one worker that $name, a 65th starts at once",
    async ({ run }) => {
      const held = gate();
      behavior = async (request) => {
        if (request.headers.get("x-marker") === "last") {
          await held.promise;
          return new Response("last");
        }
        if (request.method === "PUT") return new Response("not reading");
        await aborted(request.signal);
        return new Response("late");
      };
      const { makeRelay, opened, relay } = await startPair();

      for (let batch = 0; batch < 4; batch += 1) {
        await Promise.all(Array.from({ length: 16 }, () => run(relay, makeRelay)));
      }
      const last = settleWithin(
        relay.relay(WORKER_ID, buildCall({ headers: { "x-marker": "last" } })),
        10_000,
      );
      await poll(() => targetCalls.some((call) => call.headers.get("x-marker") === "last")).toBe(
        true,
      );
      const channels = opened();
      held.open();
      await last;

      expect(channels).toBe(65);
    },
    60_000,
  );

  it("with the worker's transport held so the {} answer overtakes a 20 MiB response, the caller still gets every byte, and its body ends only at the channel's end", async () => {
    behavior = () => Promise.resolve(new Response(patternStream(20 * MIB, 9)));
    const { pair, relay, spy } = await startPair();
    pair.workerEnd.hold();

    const pending = relay.relay(WORKER_ID, buildCall({}));
    await sleep(300);
    pair.workerEnd.release();
    const response = await pending;
    const digest = digestOf(await readParts(response.body));

    expect(digest).toBe(patternDigest(20 * MIB, 9));
    expect(spy.events).toContain("request-answered:{}");
  }, 60_000);
});
