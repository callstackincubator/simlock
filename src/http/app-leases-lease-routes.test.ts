import { describe, expect, it } from "vitest";
import { UnknownLeaseError } from "../core/index.js";
import { DispatchError } from "../daemon/dispatcher.js";
import {
  agentAuth,
  type App,
  buildHarness,
  createLeaseRequest,
  operatorAuth,
  postLeaseRequest,
  readSseFrames,
  settle,
} from "./test-app.js";
import { makeDevice, makeGrant, makeLease, waitForDispatch } from "./test-fakes.js";

describe("lease routes", () => {
  it("GET /v1/leases/:id returns the acquisition-shaped lease object", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { lease: Record<string, unknown> };
    expect(body.lease).toMatchObject({
      dataPlane: null,
      deviceId: "dev_1",
      device: "iPhone 17 Pro",
      id: "lse_1",
      platform: "ios",
      udid: "ABCD-1234",
    });
    expect(body.lease).not.toHaveProperty("worker");
    expect(body.lease).not.toHaveProperty("workerId");
  });

  it("GET /v1/leases/:id on a gateway builds the lease from its own worker's device, not another worker's with the same device id", async () => {
    const device = (workerId: string, udid: string) => ({
      ...makeDevice({ driverDeviceId: udid, id: "dev_1" }),
      workerId,
    });
    const { app, dispatcher } = buildHarness({
      registry: {
        snapshot: { devices: [device("wrk_a", "UDID-A"), device("wrk_b", "UDID-B")] },
      },
    });
    dispatcher.handlers["lease.get"] = () => ({
      lease: {
        ...makeLease({ deviceId: "dev_1", id: "wrk_b.lse_1", ownerId: "tok_agent" }),
        worker: { id: "wrk_b", label: "mac-b" },
        workerId: "wrk_b",
      },
    });

    const response = await app.request("/v1/leases/wrk_b.lse_1", { headers: agentAuth });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { lease: unknown }).lease).toMatchObject({
      deviceId: "dev_1",
      id: "wrk_b.lse_1",
      udid: "UDID-B",
      worker: { id: "wrk_b", label: "mac-b" },
      workerId: "wrk_b",
    });
  });

  it("GET /v1/leases/:id keeps a simulator's mode on the lease object", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", mode: "slim" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_1", { headers: agentAuth });

    expect(((await response.json()) as { lease: unknown }).lease).toMatchObject({ mode: "slim" });
  });

  it("GET /v1/leases/:id answers a lease on a physical device with no mode, on a worker", async () => {
    const { app, registry } = buildHarness();
    registry.devices = [
      {
        createdAt: 0,
        driverData: undefined,
        driverDeviceId: "00008110-001A2B3C4D5E",
        enrolledApps: [],
        id: "dev_phys",
        physical: true,
        spec: {
          class: "phone",
          model: "iPhone 15 Pro",
          osVersion: "18.4",
          physical: true,
          platform: "ios",
        },
        state: "leased",
      },
    ];
    registry.leases = [makeLease({ deviceId: "dev_phys", id: "lse_p", ownerId: "tok_agent" })];

    const response = await app.request("/v1/leases/lse_p", { headers: agentAuth });

    expect(response.status).toBe(200);
    const { lease } = (await response.json()) as { lease: Record<string, unknown> };
    expect(lease).toMatchObject({
      device: "iPhone 15 Pro",
      deviceId: "dev_phys",
      os: "18.4",
      udid: "00008110-001A2B3C4D5E",
    });
    expect(lease).not.toHaveProperty("mode");
  });

  it("GET /v1/leases/:id answers a lease on a physical device with no mode, on a gateway", async () => {
    const { app, dispatcher } = buildHarness({
      registry: {
        snapshot: {
          devices: [
            {
              driverDeviceId: "00008110-001A2B3C4D5E",
              id: "dev_phys",
              spec: { model: "iPhone 15 Pro", osVersion: "18.4", platform: "ios" },
              workerId: "wrk_a",
            },
          ],
        },
      },
    });
    dispatcher.handlers["lease.get"] = () => ({
      lease: {
        ...makeLease({ deviceId: "dev_phys", id: "wrk_a.lse_p", ownerId: "tok_agent" }),
        worker: { id: "wrk_a" },
        workerId: "wrk_a",
      },
    });

    const response = await app.request("/v1/leases/wrk_a.lse_p", { headers: agentAuth });

    expect(response.status).toBe(200);
    const { lease } = (await response.json()) as { lease: Record<string, unknown> };
    expect(lease).toMatchObject({ deviceId: "dev_phys", udid: "00008110-001A2B3C4D5E" });
    expect(lease).not.toHaveProperty("mode");
  });

  it("names an Android emulator's adb serial as address, beside its AVD name as udid, on the lease object the POST, the request poll and GET /v1/leases/:id answer", async () => {
    const emulator = {
      address: "emulator-5554",
      driverDeviceId: "simlock_3f9a2c1e",
      id: "dev_and",
      spec: { model: "Pixel 8", osVersion: "35", physical: false, platform: "android" },
    } as const;
    const { app, dispatcher, registry } = buildHarness();
    const posted = postLeaseRequest(app, { device: "Pixel 8", platform: "android" });
    const call = await waitForDispatch(dispatcher, "lease.request");
    call.resolve(makeGrant({ device: emulator, lease: { deviceId: "dev_and", id: "lse_and" } }));
    const created = (await (await posted).json()) as { request: { id: string; lease: unknown } };
    registry.devices = [makeDevice(emulator)];
    registry.leases = [makeLease({ deviceId: "dev_and", id: "lse_and", ownerId: "tok_agent" })];

    const polled = await app.request(`/v1/lease-requests/${created.request.id}`, {
      headers: agentAuth,
    });
    const read = await app.request("/v1/leases/lse_and", { headers: agentAuth });

    const named = { address: "emulator-5554", udid: "simlock_3f9a2c1e" };
    expect({
      get: ((await read.json()) as { lease: unknown }).lease,
      poll: ((await polled.json()) as { request: { lease: unknown } }).request.lease,
      post: created.request.lease,
    }).toMatchObject({ get: named, poll: named, post: named });
  });

  it("POST /v1/leases/:id/renew drains buffered device-health notices", async () => {
    const { app, dispatcher, eventBus, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.renew"] = (input) => ({
      deviceId: "dev_1",
      grantedAt: 1_000,
      id: (input as { leaseId: string }).leaseId,
      ownerId: "tok_agent",
      requesterId: "tok_agent",
      ttlDeadline: 2_000 + ((input as { ttlMs?: number }).ttlMs ?? 900_000),
    });

    eventBus.emit(
      "device.crash-detected",
      { deviceId: "dev_1", leaseId: "lse_1", observed: "x", platform: "ios" },
      "test",
    );
    eventBus.emit(
      "device.recovered",
      { attempts: 1, deviceId: "dev_1", duration: 500, leaseId: "lse_1", platform: "ios" },
      "test",
    );

    const response = await app.request("/v1/leases/lse_1/renew", {
      body: JSON.stringify({ ttlMs: 120_000 }),
      headers: { ...agentAuth, "content-type": "application/json" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { leaseId: string; notices: unknown[] };
    expect(body.leaseId).toBe("lse_1");
    expect(body.notices).toEqual([
      { event: "device_unhealthy" },
      { attempts: 1, event: "device_recovered" },
    ]);
  });

  it.each([
    ["renew", "/v1/leases/lse_1/renew", '{"ttlMs":60000}', "lease.renew"],
    ["exec", "/v1/leases/lse_1/exec", '{"args":["list"],"tool":"simctl"}', "device.exec"],
    [
      "install",
      "/v1/components/install",
      '{"platform":"android","version":"35"}',
      "component.install",
    ],
  ])(
    "a caller sends the %s body without a JSON content type and gets 415 UNSUPPORTED_MEDIA_TYPE; with application/json it reaches the dispatcher",
    async (_route, path, body, operation) => {
      const { app, dispatcher } = buildHarness();
      dispatcher.handlers["lease.renew"] = () => ({
        deviceId: "dev_1",
        grantedAt: 1_000,
        id: "lse_1",
        ownerId: "tok_agent",
        requesterId: "tok_agent",
        ttlDeadline: 2_000,
      });
      dispatcher.handlers["device.exec"] = () => ({ exitCode: 0 });
      dispatcher.handlers["component.install"] = () => ({
        component: "35",
        outcome: "installed",
        platform: "android",
        version: "35",
      });
      const send = (contentType: string | undefined) =>
        app.request(path, {
          body,
          headers: {
            ...agentAuth,
            ...(contentType === undefined ? {} : { "content-type": contentType }),
          },
          method: "POST",
        });

      for (const contentType of [undefined, "text/plain"]) {
        const refused = await send(contentType);
        expect(refused.status).toBe(415);
        expect(await refused.json()).toEqual({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Content-Type must be application/json",
          },
        });
      }
      expect(dispatcher.calls.filter((call) => call.operation === operation)).toEqual([]);

      const accepted = await send("application/json");
      expect(accepted.status).toBe(200);
      expect(dispatcher.calls.filter((call) => call.operation === operation)).toHaveLength(1);
    },
  );

  it("a caller sends a bad wait or renew body and gets 400 with today's message; a renew with no body, an empty body under any content type or an extra key renews", async () => {
    const { app, dispatcher } = buildHarness();
    const { id } = await createLeaseRequest(app, dispatcher);
    const renewals: unknown[] = [];
    dispatcher.handlers["lease.renew"] = (input) => {
      renewals.push(input);
      return {
        deviceId: "dev_1",
        grantedAt: 1_000,
        id: "lse_1",
        ownerId: "tok_agent",
        requesterId: "tok_agent",
        ttlDeadline: 2_000,
      };
    };
    const renew = (
      body: string | undefined,
      contentType: string | undefined = "application/json",
    ) =>
      app.request("/v1/leases/lse_1/renew", {
        ...(body === undefined ? {} : { body }),
        headers: {
          ...agentAuth,
          ...(contentType === undefined ? {} : { "content-type": contentType }),
        },
        method: "POST",
      });
    const refusedWait = "wait must be a non-negative number of seconds";

    const refusals: [string, Response | Promise<Response>, string][] = [
      [
        "wait=-1",
        app.request(`/v1/lease-requests/${id}?wait=-1`, { headers: agentAuth }),
        refusedWait,
      ],
      [
        "wait=abc",
        app.request(`/v1/lease-requests/${id}?wait=abc`, { headers: agentAuth }),
        refusedWait,
      ],
      [
        "wait=-1 on an unknown request",
        app.request("/v1/lease-requests/unknown?wait=-1", { headers: agentAuth }),
        refusedWait,
      ],
      ["ttlMs a string", renew('{"ttlMs":"60s"}'), "ttlMs must be a number"],
      ["ttlMs negative", renew('{"ttlMs":-1}'), "ttlMs must be a positive number"],
      ["ttlMs zero", renew('{"ttlMs":0}'), "ttlMs must be a positive number"],
      ["a number", renew("5"), "Body must be a JSON object"],
      ["an array", renew("[]"), "Body must be a JSON object"],
      ["malformed JSON", renew("{"), "Invalid JSON body"],
    ];
    for (const [name, pending, message] of refusals) {
      const response = await pending;
      expect(response.status, name).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "BAD_REQUEST", message } });
    }
    expect(renewals).toEqual([]);

    for (const response of [
      await renew(undefined, undefined),
      await renew("", "application/json"),
      await renew("", "text/plain"),
      await renew("", "application/x-www-form-urlencoded"),
      await renew('{"ttlMs":60000,"note":"x"}'),
    ]) {
      expect(response.status).toBe(200);
    }
    expect(renewals).toEqual([
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1" },
      { leaseId: "lse_1", ttlMs: 60_000 },
    ]);
  });

  it("404s a renew for an unknown lease", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.renew"] = () => {
      throw new UnknownLeaseError("lse-missing");
    };

    const response = await app.request("/v1/leases/lse-missing/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );
  });

  it("403s a renew for another requester's still-live lease -- dispatched directly through lease.renew's own ownsLease hook, not lease.list's 404-for-everything filter (S6)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.renew"] = () => {
      throw new DispatchError("FORBIDDEN", "Not authorized for lease.renew");
    };

    const response = await app.request("/v1/leases/lse_other/renew", {
      headers: agentAuth,
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("streams live lease notices over SSE, ending on lease_lost -- fed by the owner-routed fact bus, not a direct eventBus subscription", async () => {
    const { app, eventBus, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];

    const streamResponse = await app.request("/v1/leases/lse_1/events", { headers: agentAuth });
    const framesPromise = readSseFrames(streamResponse, 2);
    await Promise.resolve();
    eventBus.emit(
      "device.crash-detected",
      { deviceId: "dev_1", leaseId: "lse_1", observed: "x", platform: "ios" },
      "test",
    );
    eventBus.emit(
      "lease.expired",
      { deviceId: "dev_1", leaseId: "lse_1", ownerId: "tok_agent" },
      "test",
    );
    const frames = await framesPromise;

    expect(frames.map((frame) => frame.event)).toEqual(["device_unhealthy", "lease_lost"]);
  });

  describe("POST /v1/leases/:id/exec", () => {
    function postExec(
      app: App,
      body: Record<string, unknown> = { args: ["list"], tool: "simctl" },
    ) {
      return app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify(body),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
    }

    it("streams a chunk per output event and ends with the command's exit code", async () => {
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      expect(call.input).toEqual({ args: ["list"], leaseId: "lse_1", tool: "simctl" });

      // why: The stream opens when the process starts, not when it first speaks (ADR 0005 §19e).
      // This chunk lands in the window between the two, which is the only thing the route's
      // handoff buffer is for: it must still arrive, and still arrive first.
      call.session.onStarted?.();
      call.session.onOutput?.("stdout", "one");
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const framesPromise = readSseFrames(response, 3);
      await Promise.resolve();
      call.session.onOutput?.("stderr", "two");
      call.resolve({ exitCode: 5 });
      const frames = await framesPromise;

      expect(frames.map((frame) => frame.event)).toEqual(["output", "output", "exit"]);
      expect(frames.map((frame) => frame.data)).toEqual([
        { chunk: "one", stream: "stdout" },
        { chunk: "two", stream: "stderr" },
        { exitCode: 5 },
      ]);
    });

    it("answers a failure that lands before any output with its own status, not a stream", async () => {
      // why: An SSE response cannot take back its status code, so ownership and the refusal list
      // have to be answered ahead of the stream -- 403 here, exactly as `renew`/`release` do.
      const { app, dispatcher } = buildHarness();
      dispatcher.handlers["device.exec"] = () => {
        throw new DispatchError("FORBIDDEN", "Not authorized for device.exec");
      };

      const response = await postExec(app);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    });

    it("reports a failure that lands after output began as a terminal error event", async () => {
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      call.session.onOutput?.("stdout", "working");
      const response = await responsePromise;

      const framesPromise = readSseFrames(response, 2);
      await Promise.resolve();
      call.reject(new DispatchError("EXEC_TIMEOUT", "exceeded exec.timeoutMs (1000ms)"));
      const frames = await framesPromise;

      expect(frames.map((frame) => frame.event)).toEqual(["output", "error"]);
      expect(frames.at(-1)?.data).toMatchObject({ error: { code: "EXEC_TIMEOUT" } });
    });

    it("forwards requesterId unchanged for both an operator and an agent token, leaving the FORBIDDEN decision to device.exec's own authorize hook", async () => {
      // why: Requester identity is never client-declared over HTTP: the token is the identity,
      // except for an operator token proxying for someone (ADR 0005 §19b/§27). Round 4, F4: this route used to decide on its own
      // that an agent token may not supply `requesterId` at all, which left that rule living
      // only in the HTTP transport (ADR 0003 §2 puts a contract operation's answer in the
      // dispatcher). The rule moved into `device.exec`'s own `authorize` hook -- exercised
      // directly in `dispatcher-exec.test.ts` -- so this route now forwards `requesterId` exactly
      // the same way for either token and merely surfaces whatever the dispatcher answers.
      const { app, dispatcher } = buildHarness();

      const asOperator = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: "agent-7", tool: "simctl" }),
        headers: { ...operatorAuth, "content-type": "application/json" },
        method: "POST",
      });
      const operatorCall = await waitForDispatch(dispatcher, "device.exec");
      expect(operatorCall.input).toEqual({
        args: ["list"],
        leaseId: "lse_1",
        requesterId: "agent-7",
        tool: "simctl",
      });
      operatorCall.session.onStarted?.();
      operatorCall.resolve({ exitCode: 0 });
      await asOperator;

      // why: Forwarded exactly the same way for an agent token -- the route makes no distinction
      // any more. `FakeDispatcher` has no `authorize` hook of its own to reject this with, so
      // the rejection is simulated here (`DispatchError("FORBIDDEN", ...)`, precisely what the
      // real dispatcher's `authorize` hook now throws for this case) to prove this route still
      // surfaces it as a 403 rather than requiring a route-level check to produce one.
      const asAgent = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: "agent-7", tool: "simctl" }),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
      const agentCall = await waitForDispatch(dispatcher, "device.exec", 1);
      expect(agentCall.input).toEqual({
        args: ["list"],
        leaseId: "lse_1",
        requesterId: "agent-7",
        tool: "simctl",
      });
      agentCall.reject(new DispatchError("FORBIDDEN", "Not authorized for device.exec"));
      const asAgentResponse = await asAgent;
      expect(asAgentResponse.status).toBe(403);
      expect(((await asAgentResponse.json()) as { error: { code: string } }).error.code).toBe(
        "FORBIDDEN",
      );

      // why: A `null` for either optional is the documented example's own spelling, and normalizes
      // to an omitted field rather than a 400 -- including for an agent, which is not
      // "supplying a requesterId".
      const withNulls = app.request("/v1/leases/lse_1/exec", {
        body: JSON.stringify({ args: ["list"], requesterId: null, stdin: null, tool: "simctl" }),
        headers: { ...agentAuth, "content-type": "application/json" },
        method: "POST",
      });
      const nullCall = await waitForDispatch(dispatcher, "device.exec", 2);
      expect(nullCall.input).toEqual({ args: ["list"], leaseId: "lse_1", tool: "simctl" });
      nullCall.session.onStarted?.();
      nullCall.resolve({ exitCode: 0 });
      await withNulls;
    });

    it("dispatches an unwrapped tool rather than rejecting it, and 400s a malformed body", async () => {
      // why: Which wrappers exist is the drivers' answer: `bash` is a tool this host does not wrap
      // (`UNKNOWN_PASSTHROUGH_TOOL`, 422, from the driver catalog -- see the dispatcher suite),
      // not a malformed request. `400` here is about the body's shape only.
      const { app, dispatcher } = buildHarness();

      const unwrapped = postExec(app, { args: [], tool: "bash" });
      const call = await waitForDispatch(dispatcher, "device.exec");
      expect(call.input).toEqual({ args: [], leaseId: "lse_1", tool: "bash" });
      call.reject(
        new DispatchError("UNKNOWN_PASSTHROUGH_TOOL", "No driver provides a bash passthrough"),
      );
      const refused = await unwrapped;
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        "UNKNOWN_PASSTHROUGH_TOOL",
      );

      for (const body of [
        { args: [] },
        { args: "list", tool: "simctl" },
        { args: [], tool: "simctl", unexpected: true },
        { args: [], requesterId: "a\u001b[2Jb", tool: "simctl" },
        { args: [], requesterId: "x".repeat(257), tool: "simctl" },
        { args: [], stdin: "A".repeat(8_388_609), tool: "simctl" },
      ]) {
        const response = await postExec(app, body);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          "BAD_REQUEST",
        );
      }
      expect(dispatcher.calls.filter((call) => call.operation === "device.exec")).toHaveLength(1);
    });

    it("opens the stream when the process starts, before it has written anything", async () => {
      // why: ADR 0005 §19e: a command that prints nothing for nine minutes still gets its `200` and
      // its keepalives, and an `EXEC_TIMEOUT` therefore always arrives as the stream's terminal
      // event rather than as a status the client can no longer be given.
      //
      // C3 (round 3 review): this only proves that half of the route's *own* logic given a
      // dispatcher that calls `onStarted` when told to (`call.session.onStarted?.()` below is
      // this test driving that by hand) -- it says nothing about when a real dispatcher actually
      // calls it, and cannot notice a dispatcher that stops calling it for a genuinely silent,
      // long-running command. That is the gateway's own job (`FleetForwarding.exec` in
      // `src/gateway/fleet-forwarding.ts`); the invariant this comment describes is guarded end
      // to end there, not here -- see `fleet-coordinator.test.ts`'s "relays the worker's own
      // started push for a silent command that never answers (ADR §19a/§19b/§19e)".
      const { app, clock, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);

      const framesPromise = readSseFrames(response, 1);
      await Promise.resolve();
      clock.advance(15_000);
      call.reject(new DispatchError("EXEC_TIMEOUT", "exceeded exec.timeoutMs (600000ms)"));
      const frames = await framesPromise;
      expect(frames).toEqual([
        { data: { error: { code: "EXEC_TIMEOUT", message: expect.any(String) } }, event: "error" },
      ]);
    });

    it("stalls the command when the client stops reading, instead of buffering for it", async () => {
      // why: ADR 0005 §19e end to end. The route hands each chunk's SSE write back through
      // `onOutput`, the process runner awaits it, so a client that opened the stream and does
      // not read stops the command at its own pipe -- the alternative being an unbounded
      // in-process queue for exactly the client least able to consume it.
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      const reader = response.body?.getReader();
      await Promise.resolve();

      const settled: number[] = [];
      let pending: number | undefined;
      for (let index = 0; index < 64 && pending === undefined; index += 1) {
        const delivery = Promise.resolve(call.session.onOutput?.("stdout", `chunk-${index}`)).then(
          () => settled.push(index),
        );
        // why: A delivery that has not settled after the microtask queue drains is the stream
        // refusing more, which is the state this test exists to reach.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!settled.includes(index)) {
          pending = index;
          void delivery;
        }
      }
      expect(pending, "the unread stream never applied backpressure").toBeDefined();

      // why: Reading again lets the queued writes through, and the stalled delivery completes --
      // the command resumes rather than having been dropped. Each read is bounded: once the
      // queue is empty a further read would block on the very producer this test has stalled.
      for (let attempt = 0; attempt < 8 && !settled.includes(pending as number); attempt += 1) {
        await Promise.race([reader?.read(), new Promise((resolve) => setTimeout(resolve, 20))]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(settled).toContain(pending);

      await reader?.cancel();
      call.resolve({ exitCode: 0 });
      await responsePromise;
    });

    it("survives a client that disconnects while the command keeps writing", async () => {
      // why: The command runs on deliberately, so chunks keep arriving at a route with nowhere to
      // put them. They go nowhere and the request still settles normally -- what "nowhere"
      // means precisely, and that nothing accumulates, is `output-relay.test.ts`.
      const { app, dispatcher } = buildHarness();

      const responsePromise = postExec(app);
      const call = await waitForDispatch(dispatcher, "device.exec");
      call.session.onStarted?.();
      const response = await responsePromise;
      const reader = response.body?.getReader();
      await Promise.resolve();
      await reader?.cancel();
      await Promise.resolve();

      expect(call.session.onOutput).toBeDefined();
      const chunk = "x".repeat(1_024);
      for (let index = 0; index < 1_000; index += 1) call.session.onOutput?.("stdout", chunk);

      // why: The relay is dropped, not merely detached: a chunk after the disconnect is discarded
      // outright, which is observable as the delivery no longer being something to wait for.
      // (Without the `relay.drop()` in the route's unsubscribe, this returns the pending write
      // of a stream nobody will ever read.)
      const onOutput = call.session.onOutput;
      if (onOutput === undefined) throw new Error("the exec dispatch has no onOutput");
      expect(onOutput("stdout", chunk)).toBeUndefined();

      call.resolve({ exitCode: 0 });
      await settle();
      await expect(reader?.read()).resolves.toMatchObject({ done: true });
    });
  });

  it("DELETE /v1/leases/:id releases and answers 202 with the device's post-release state", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1", state: "leased" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.release"] = (input) => {
      const leaseId = (input as { leaseId: string }).leaseId;
      registry.leases = registry.leases.filter((lease) => lease.id !== leaseId);
      // why: Not `reclaiming`: that is also the route's default for a device it cannot find, so only
      // another state proves the answer is read from the registry.
      registry.devices = registry.devices.map((device) =>
        device.id === "dev_1" ? { ...device, state: "quarantined" } : device,
      );
      return { leaseId };
    };

    const response = await app.request("/v1/leases/lse_1", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      device: { id: "dev_1", state: "quarantined" },
      released: true,
    });
  });

  it("an operator may release another requester's lease (lease.list's own admin bypass)", async () => {
    const { app, dispatcher, registry } = buildHarness();
    registry.devices = [makeDevice({ id: "dev_1" })];
    registry.leases = [makeLease({ deviceId: "dev_1", id: "lse_1", ownerId: "tok_agent" })];
    dispatcher.handlers["lease.release"] = (input) => ({
      leaseId: (input as { leaseId: string }).leaseId,
    });

    const response = await app.request("/v1/leases/lse_1", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(202);
  });

  it("404s a release for an unknown lease", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.release"] = () => {
      throw new UnknownLeaseError("lse-missing");
    };

    const response = await app.request("/v1/leases/lse-missing", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );
  });

  it("403s a release of another requester's still-live lease -- dispatched directly through lease.release's own ownsLease hook, not lease.list's 404-for-everything filter (S6)", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["lease.release"] = () => {
      throw new DispatchError("FORBIDDEN", "Not authorized for lease.release");
    };

    const response = await app.request("/v1/leases/lse_other", {
      headers: agentAuth,
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
});
