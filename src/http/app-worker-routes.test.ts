import { describe, expect, it } from "vitest";
import { runDispatch } from "../daemon/dispatch.js";
import { DispatchError } from "../daemon/dispatcher.js";
import { testConfig } from "../core/testing.js";
import {
  agentAuth,
  buildHarness,
  defaultBody,
  operatorAuth,
  postLeaseRequest,
} from "./test-app.js";

describe("worker routes", () => {
  function gatewayHarness() {
    return buildHarness();
  }

  it("are routes on a worker too (ADR 0012 §3), each dispatching its operation", async () => {
    const { app, dispatcher } = buildHarness();
    dispatcher.handlers["worker.list"] = () => ({ workers: [] });
    for (const operation of ["worker.drain", "worker.undrain", "worker.remove"] as const) {
      dispatcher.handlers[operation] = () => {
        throw new DispatchError("UNSUPPORTED_IN_WORKER_MODE", `${operation} is refused`, {
          operation,
        });
      };
    }

    const list = await app.request("/v1/workers", { headers: operatorAuth });
    const drain = await app.request("/v1/workers/w/drain", {
      headers: operatorAuth,
      method: "POST",
    });
    const undrain = await app.request("/v1/workers/w/drain", {
      headers: operatorAuth,
      method: "DELETE",
    });
    const remove = await app.request("/v1/workers/w", { headers: operatorAuth, method: "DELETE" });

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ workers: [] });
    const refusals = [drain, undrain, remove];
    expect(refusals.map((response) => response.status)).toEqual([501, 501, 501]);
    expect(await Promise.all(refusals.map((response) => response.json()))).toEqual(
      ["worker.drain", "worker.undrain", "worker.remove"].map((operation) => ({
        error: { code: "UNSUPPORTED_IN_WORKER_MODE", message: expect.any(String), operation },
      })),
    );
  });

  it("GET /v1/workers returns the views", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.list"] = () => ({
      workers: [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          id: "wrk_1",
          lastSeenAt: 1,
          leases: [],
        },
      ],
    });

    const response = await app.request("/v1/workers", { headers: operatorAuth });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workers: [{ id: "wrk_1" }] });
  });

  it("GET /v1/inbox dispatches inbox.get for the caller and answers its items", async () => {
    const { app, dispatcher } = gatewayHarness();
    const item = {
      condition: "disconnected",
      group: "Broken",
      key: "wrk_1/disconnected",
      worker: {
        connection: "disconnected",
        drained: false,
        heldLeases: 0,
        id: "wrk_1",
        lastSeenAt: 1,
        leasedDevices: 0,
      },
    };
    dispatcher.handlers["inbox.get"] = () => ({ items: [item] });

    const response = await app.request("/v1/inbox", { headers: operatorAuth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [item] });
    expect(dispatcher.calls.map((call) => [call.operation, call.session.role])).toEqual([
      ["inbox.get", "admin"],
    ]);
  });

  it("GET /v1/config dispatches config.get for the caller and answers the config; an agent token is a 403, no token a 401", async () => {
    const { app, dispatcher } = gatewayHarness();
    const config = testConfig({ update: { check: false } }, "gateway");
    // why: `config.get`'s own role check runs through the contract's real pipeline; the route adds none.
    dispatcher.handlers["config.get"] = (input, session) =>
      runDispatch("config.get", input, session, {
        handlers: {
          "config.get": (configInput) => {
            expect(configInput).toEqual({});
            return config;
          },
        },
      });

    const asOperator = await app.request("/v1/config", { headers: operatorAuth });
    const asAgent = await app.request("/v1/config", { headers: agentAuth });
    const anonymous = await app.request("/v1/config");

    expect(asOperator.status).toBe(200);
    expect(await asOperator.json()).toMatchObject({ mode: "gateway", update: { check: false } });
    expect(asAgent.status).toBe(403);
    expect(((await asAgent.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(anonymous.status).toBe(401);
    expect(dispatcher.calls.map((call) => [call.operation, call.session.role])).toEqual([
      ["config.get", "admin"],
      ["config.get", "agent"],
    ]);
  });

  it("maps drain, undrain and remove onto their operations, with the id from the path", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.drain"] = (input: never) => ({
      drained: true,
      workerId: (input as { workerId: string }).workerId,
    });
    dispatcher.handlers["worker.undrain"] = (input: never) => ({
      drained: false,
      workerId: (input as { workerId: string }).workerId,
    });
    dispatcher.handlers["worker.remove"] = (input: never) => ({
      removed: true,
      workerId: (input as { workerId: string }).workerId,
    });

    const drained = await app.request("/v1/workers/wrk_1/drain", {
      headers: operatorAuth,
      method: "POST",
    });
    expect(await drained.json()).toEqual({ drained: true, workerId: "wrk_1" });
    const undrained = await app.request("/v1/workers/wrk_1/drain", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(await undrained.json()).toEqual({ drained: false, workerId: "wrk_1" });
    const removed = await app.request("/v1/workers/wrk_2", {
      headers: operatorAuth,
      method: "DELETE",
    });
    expect(await removed.json()).toEqual({ removed: true, workerId: "wrk_2" });

    expect(dispatcher.calls.map((call) => call.operation)).toEqual([
      "worker.drain",
      "worker.undrain",
      "worker.remove",
    ]);
  });

  it("puts a refusal's typed details in the body, so a client need not parse prose", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["worker.remove"] = () => {
      throw new DispatchError("WORKER_CONNECTED", "Worker wrk_1 is still connected", {
        workerId: "wrk_1",
      });
    };

    const response = await app.request("/v1/workers/wrk_1", {
      headers: operatorAuth,
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "WORKER_CONNECTED", message: expect.any(String), workerId: "wrk_1" },
    });
  });

  it("answers 501 for an operation a gateway does not implement", async () => {
    const { app, dispatcher } = gatewayHarness();
    dispatcher.handlers["lease.request"] = () => {
      throw new DispatchError(
        "UNSUPPORTED_IN_GATEWAY_MODE",
        "lease.request is not available on a gateway yet",
        { operation: "lease.request" },
      );
    };

    const response = await postLeaseRequest(app, defaultBody);

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_IN_GATEWAY_MODE", operation: "lease.request" },
    });
  });
});
