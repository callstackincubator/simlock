import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type TwoWayRelay } from "../gateway/index.js";
import { TYPE } from "../link/testing.js";
import type { RelayTarget, TwoWayRelayTarget } from "./relay.js";
import type { StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import {
  cleanUp,
  gate,
  settleWithin,
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

  it("a gateway started with http.proxyAuth relays a request to its worker without the proxy's header or cookie", async () => {
    const { relay, workerId } = await startFleet(undefined, {
      proxyAuth: {
        audience: "aud",
        header: "cf-access-jwt-assertion",
        issuer: "https://team.example",
        jwksUrl: "http://127.0.0.1:1/jwks",
      },
    });

    await relay.relay(
      workerId,
      buildCall({
        headers: {
          cookie: "CF_Authorization=person.jwt",
          "cf-access-jwt-assertion": "person.jwt",
          "x-test": "1",
        },
      }),
    );

    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(targetCalls[0]?.headers.get("cookie")).toBeNull();
    expect(targetCalls[0]?.headers.get("x-test")).toBe("1");
  }, 30_000);

  it("through startFleet, a relayed GET opens a channel on the link between the gateway and the worker", async () => {
    behavior = () => Promise.resolve(new Response("over a channel"));
    const { relay, taps, workerId } = await startFleet();

    const response = await relay.relay(workerId, buildCall({}));
    const body = await response.text();

    expect(body).toBe("over a channel");
    expect(taps.flatMap((tap) => tap.binaries(TYPE.OPEN)).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("startFleet starts its gateway when the gatewayUrl hook opens a listener on the gateway's port, and the hook's listener does not get that port", async () => {
    // why: the timing file's hook starts a proxy with listen(0), which may draw the port startFleet picked; listening on that port makes the draw certain.
    const squatter = createServer();
    let squatterBound = false;

    const outcome = await startFleet_(
      { daemons, directories, target },
      {
        gatewayUrl: async (port) => {
          await new Promise<void>((resolve) => {
            squatter.once("error", () => resolve());
            squatter.listen(port, "127.0.0.1", () => {
              squatterBound = true;
              resolve();
            });
          });
          return `ws://127.0.0.1:${String(port)}`;
        },
      },
    ).then(
      () => "started",
      (error: unknown) => String((error as { code?: unknown }).code ?? error),
    );
    if (squatterBound) await new Promise<void>((resolve) => squatter.close(() => resolve()));

    expect(outcome).toBe("started");
    expect(squatterBound).toBe(false);
  }, 30_000);

  it("a gateway module's two-way relay carries bytes both ways at once until either side ends", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const { relay, workerId } = await startFleet();
    const open = async () => {
      const opened = await relay.relayTwoWay(workerId, buildCall({}));
      expect(opened).not.toBeInstanceOf(Response);
      const two = opened as TwoWayRelay;
      const reader = two.readable.getReader();
      const readText = async (length: number): Promise<string> => {
        let seen = "";
        while (seen.length < length) {
          const step = await reader.read();
          if (step.done) break;
          seen += decoder.decode(step.value);
        }
        return seen;
      };
      return { reader, readText, two, writer: two.writable.getWriter() };
    };

    twoWayBehavior = (_request, _tenant, _leaseId, pipe) => {
      void (async () => {
        const writer = pipe.writable.getWriter();
        const reader = pipe.readable.getReader();
        await writer.write(encoder.encode("hello from worker"));
        for (;;) {
          const step = await reader.read();
          if (step.done) return;
          await writer.write(step.value);
        }
      })().catch(() => undefined);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const both = await open();
    const first = await both.readText("hello from worker".length);
    await both.writer.write(encoder.encode("ping"));
    const echoed = await both.readText("ping".length);

    const heard = gate();
    let heardText = "";
    let endedSignal: AbortSignal | undefined;
    twoWayBehavior = (_request, _tenant, _leaseId, pipe) => {
      endedSignal = pipe.signal;
      void (async () => {
        const writer = pipe.writable.getWriter();
        await writer.write(encoder.encode("bye"));
        await writer.close();
        const reader = pipe.readable.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          heardText += decoder.decode(step.value);
        }
        heard.open();
      })().catch(() => undefined);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const workerEnds = await open();
    const bye = await workerEnds.readText(3);
    const afterBye = await workerEnds.reader.read();
    await workerEnds.writer.write(encoder.encode("late"));
    await workerEnds.writer.close();
    await heard.promise;

    const more = gate();
    twoWayBehavior = (_request, _tenant, _leaseId, pipe) => {
      void (async () => {
        const writer = pipe.writable.getWriter();
        await writer.write(encoder.encode("one"));
        await more.promise;
        await writer.write(encoder.encode("two"));
        await writer.close();
      })().catch(() => undefined);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const gatewayEnds = await open();
    const one = await gatewayEnds.readText(3);
    await gatewayEnds.writer.close();
    more.open();
    const two = await settleWithin(gatewayEnds.readText(3));
    const afterTwo = await settleWithin(gatewayEnds.reader.read());

    const signals: AbortSignal[] = [];
    twoWayBehavior = (_request, _tenant, _leaseId, pipe) => {
      signals.push(pipe.signal);
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const cancelled = await open();
    const abortedWrites = await open();
    await cancelled.reader.cancel();
    await abortedWrites.writer.abort(new Error("gone"));
    await poll(() => signals.map((signal) => signal.aborted)).toEqual([true, true]);
    await both.reader.cancel();

    expect(both.two.status).toBe(200);
    expect(first).toBe("hello from worker");
    expect(echoed).toBe("ping");
    expect(bye).toBe("bye");
    expect(afterBye.done).toBe(true);
    expect(heardText).toBe("late");
    expect(endedSignal?.aborted).toBe(false);
    expect(one).toBe("one");
    expect(two).toEqual({ state: "fulfilled", value: "two" });
    expect(afterTwo).toMatchObject({ state: "fulfilled", value: { done: true } });
    expect(signals).toHaveLength(2);
  }, 30_000);

  it("a gateway module opening a two-way relay gets the worker's refusal or an error", async () => {
    twoWayBehavior = () =>
      Promise.resolve(new Response("not for you", { headers: { "x-why": "no" }, status: 403 }));
    const { relay, workerId } = await startFleet();

    const refused = await relay.relayTwoWay(workerId, buildCall({}));
    const missing = await settleWithin(
      relay.relayTwoWay(workerId, buildCall({ target: "agent-device" })),
    );

    expect(refused).toBeInstanceOf(Response);
    const refusal = refused as Response;
    expect(refusal.status).toBe(403);
    expect(refusal.headers.get("x-why")).toBe("no");
    expect(await refusal.text()).toBe("not for you");
    expect(missing).toMatchObject({ code: "RELAY_TARGET_MISSING", state: "rejected" });
  }, 30_000);
});
