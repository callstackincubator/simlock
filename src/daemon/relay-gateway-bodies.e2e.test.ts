import { afterEach, describe, expect, it } from "vitest";
import { GatewayRelay, type GatewayWorkerClient, type WorkerDirectory } from "../gateway/index.js";
import { linkPair, TYPE } from "../link/testing.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import type { DispatchSession } from "./dispatch.js";
import type { RelayTarget, TwoWayRelayTarget } from "./relay.js";
import type { StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import {
  cleanUp,
  gate,
  MIB,
  KIB,
  patternBytes,
  patternStream,
  settleWithin,
  sleep,
  startFleet as startFleet_,
  startWorker,
  type FleetExec,
  type WorkerFixture,
} from "./test-relay-support.js";
import { WORKER_ID, buildCall, spyOn } from "./test-relay-gateway.js";

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
});
