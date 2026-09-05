import { describe, expect, it } from "vitest";

import { waitForLeaseCount, withDaemon, type CliResult } from "./helpers/index.js";

/**
 * Asserts the documented failure contract from docs/CLI.md#global-exit-codes: exit
 * code, exactly one structured JSON line on stderr, empty stdout.
 */
function expectStructuredFailure(result: CliResult, exitCode: number, errorCode: string): void {
  expect(result.code).toBe(exitCode);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stderr)).toEqual({
    error: { code: errorCode, message: expect.any(String) },
  });
}

describe("error and exit-code table", () => {
  it.each([
    { name: "unknown command", args: ["frobnicate"], exitCode: 2, errorCode: "USAGE" },
    { name: "missing required lease flags", args: ["lease"], exitCode: 2, errorCode: "USAGE" },
    {
      name: "empty --agent-id",
      args: ["lease", "--platform", "ios", "--device", "iPhone 16", "--agent-id", ""],
      exitCode: 2,
      errorCode: "USAGE",
    },
    {
      name: "--json on an already-JSON-only command",
      args: ["list", "--json"],
      exitCode: 2,
      errorCode: "USAGE",
    },
  ])("$name -> exit $exitCode ($errorCode)", async ({ args, exitCode, errorCode }) => {
    const env = await withDaemon();
    const result = await env.cli(args);
    expectStructuredFailure(result, exitCode, errorCode);
  });

  it("UNKNOWN_MODEL -> exit 12", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { failures: { resolveSpec: { type: "UnknownModelError", model: "Bogus Phone" } } },
    });

    const result = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "Bogus Phone",
      "--detach",
    ]);
    expectStructuredFailure(result, 12, "UNKNOWN_MODEL");
  });

  it("RUNTIME_MISSING without --allow-download -> exit 12, and never attempts a download", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { failures: { resolveSpec: { type: "RuntimeMissingError", osVersion: "999.0" } } },
    });
    await env.driverLog.clear();

    const result = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "999.0",
      "--detach",
    ]);
    expectStructuredFailure(result, 12, "RUNTIME_MISSING");

    const calls = await env.driverLog.calls();
    expect(calls.some((call) => call.operation === "resolveSpec")).toBe(true);
    expect(calls.some((call) => call.operation === "provision")).toBe(false);
  });

  it("UNKNOWN_LEASE (lease renew on an unknown id) -> falls back to exit 1", async () => {
    const env = await withDaemon();
    const result = await env.cli(["lease", "renew", "lse_does-not-exist"]);
    expectStructuredFailure(result, 1, "UNKNOWN_LEASE");
  });

  it("lease renew on a running holder's lease -> exit 0 with a later deadline", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });

    const holder = env.cliBackground([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--agent-id",
      "flow4-holder",
    ]);
    const grant = JSON.parse(await holder.firstStdoutLine()) as {
      lease: { id: string; ttlMs: number };
    };

    try {
      const rows = await waitForLeaseCount(env, 1);
      const before = rows.find((row) => row.id === grant.lease.id);
      if (before === undefined) {
        throw new Error(`lease ${grant.lease.id} not found before renew`);
      }
      const beforeDeadline = before.ttlDeadline as number;

      const result = await env.cli(["lease", "renew", grant.lease.id]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const renewed = result.json as { id: string; ttlMs: number; ttlDeadline: number };
      expect(renewed.id).toBe(grant.lease.id);
      // ADR 0004: one kind of lease, and a body-less renew re-applies its own stored width
      // rather than any mode-shaped default.
      expect(renewed.ttlMs).toBe(grant.lease.ttlMs);
      expect(renewed.ttlDeadline).toBeGreaterThan(beforeDeadline);
    } finally {
      holder.kill("SIGTERM");
      await holder.waitForExit(15_000);
    }
  });
});
