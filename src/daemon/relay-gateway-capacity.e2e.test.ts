import { afterEach, describe, expect, it } from "vitest";
import { GatewayRelay, type GatewayWorkerClient, type WorkerDirectory } from "../gateway/index.js";
import { linkPair, TYPE } from "../link/testing.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import type { RelayTarget, TwoWayRelayTarget } from "./relay.js";
import type { DaemonServer } from "./server.js";
import {
  aborted,
  cleanUp,
  digestOf,
  gate,
  MIB,
  patternDigest,
  patternStream,
  readParts,
  settleWithin,
  sleep,
  startWorker,
  type WorkerFixture,
} from "./test-relay-support.js";
import { WORKER_ID, buildCall, spyOn } from "./test-relay-gateway.js";

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

  async function startPair(
    options: { readonly deadlineMs?: number; readonly idleMs?: number } = {},
  ) {
    const fixture: WorkerFixture = await startWorker(
      directories,
      daemons,
      { "agent-device": target, echo: target },
      { relayTwoWayTargets: { echo: twoWayTarget } },
    );
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
