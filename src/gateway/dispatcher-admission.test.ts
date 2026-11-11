import { describe, expect, it } from "vitest";
import { ScriptedProcessRunner } from "../ports/index.js";
import { grantFixture, ScriptedWorkerClient } from "./test-support.js";
import { harness, session } from "./test-dispatcher.js";
import { connectWorker } from "./test-fleet.js";

describe("GatewayDispatcher: the admission command's input", () => {
  it("the admission command reads the requester, the principal, the platform, the request as the caller sent it and metadata", async () => {
    const cases = [
      {
        input: { model: "iPhone 17", noWait: true, platform: "ios" },
        name: "ttlMs not sent",
        requesterId: "tok_7f3a",
        request: { model: "iPhone 17", noWait: true, platform: "ios" },
      },
      {
        input: { allowDownload: true, noWait: true, platform: "android" },
        name: "allowDownload sent",
        requesterId: "tok_7f3a",
        request: { allowDownload: true, noWait: true, platform: "android" },
      },
      {
        input: { leaseId: "job-78", noWait: true, platform: "ios" },
        name: "a chosen leaseId",
        requesterId: "tok_7f3a",
        request: { leaseId: "job-78", noWait: true, platform: "ios" },
      },
      {
        input: {
          idempotencyKey: "k-1",
          noWait: true,
          platform: "ios",
          requesterId: "job-78",
          ttlMs: 60_000,
        },
        name: "a requester id other than the principal",
        requesterId: "job-78",
        request: { noWait: true, platform: "ios", ttlMs: 60_000 },
      },
    ] as const;

    for (const { input, name, request, requesterId } of cases) {
      const runner = new ScriptedProcessRunner([
        {
          match: { args: ["/etc/simlock/policy.ts"], command: "bun" },
          result: { code: 0, stderr: "", stdout: "{}" },
        },
      ]);
      const { dispatcher } = harness({
        admission: { command: ["bun", "/etc/simlock/policy.ts"], runner, timeoutMs: 5_000 },
      });

      await dispatcher
        .dispatch("lease.request", input, session({ principal: "tok_7f3a", role: "agent" }))
        .catch(() => undefined);

      const stdin = runner.calls[0]?.options.input ?? "";
      expect(stdin.endsWith("\n"), name).toBe(true);
      expect(JSON.parse(stdin), name).toEqual({
        metadata: {},
        platform: input.platform,
        principal: "tok_7f3a",
        request,
        requesterId,
      });
    }
  });

  it("a caller's metadata reaches the admission command, and the command's request holds no metadata", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["/etc/simlock/policy.ts"], command: "bun" },
        result: { code: 0, stderr: "", stdout: "{}" },
      },
    ]);
    const { dispatcher } = harness({
      admission: { command: ["bun", "/etc/simlock/policy.ts"], runner, timeoutMs: 5_000 },
    });

    await dispatcher
      .dispatch(
        "lease.request",
        { metadata: { project: "checkout-app", role: "ci" }, noWait: true, platform: "ios" },
        session({ principal: "tok_7f3a", role: "agent" }),
      )
      .catch(() => undefined);

    expect(JSON.parse(runner.calls[0]?.options.input ?? "")).toEqual({
      metadata: { project: "checkout-app", role: "ci" },
      platform: "ios",
      principal: "tok_7f3a",
      request: { noWait: true, platform: "ios" },
      requesterId: "tok_7f3a",
    });
  });

  it("a request's metadata is never emitted or forwarded to a worker", async () => {
    const runner = new ScriptedProcessRunner([
      {
        match: { args: ["/etc/simlock/policy.ts"], command: "bun" },
        result: { code: 0, stderr: "", stdout: "{}" },
      },
    ]);
    const { dispatcher, directory, eventBus, workers } = harness({
      admission: { command: ["bun", "/etc/simlock/policy.ts"], runner, timeoutMs: 5_000 },
    });
    const client = new ScriptedWorkerClient();
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");

    await dispatcher.dispatch(
      "lease.request",
      { metadata: { project: "checkout-app" }, model: "iPhone 17", noWait: true, platform: "ios" },
      session({ principal: "tok_7f3a", role: "agent" }),
    );

    expect(runner.calls[0]?.options.input).toContain("checkout-app");
    expect(client.lastRequestLeaseInput, "the call to the worker").toBeDefined();
    expect(JSON.stringify(client.lastRequestLeaseInput)).not.toContain("checkout-app");
    expect(eventBus.replay().some((event) => event.event === "lease.requested")).toBe(true);
    expect(JSON.stringify(eventBus.replay()), "the events").not.toContain("checkout-app");
  });
});
