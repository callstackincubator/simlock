import { describe, expect, it } from "vitest";
import { ScriptedProcessRunner } from "../ports/index.js";
import { harness, session } from "./test-dispatcher.js";

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
});
