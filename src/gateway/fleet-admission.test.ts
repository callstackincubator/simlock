import { describe, expect, it } from "vitest";
import type { EventMap } from "../bus/index.js";
import { ScriptedProcessRunner } from "../ports/index.js";
import { REQUEST, harness, requestOptions } from "./test-fleet.js";

const COMMAND = ["bun", "/etc/simlock/policy.ts"] as const;

function admissionFleet(stdout: string) {
  const runner = new ScriptedProcessRunner([
    {
      match: { args: [COMMAND[1]], command: COMMAND[0] },
      result: { code: 0, stderr: "", stdout },
    },
  ]);
  const fleet = harness({ admission: { command: COMMAND, runner, timeoutMs: 5_000 } });
  const requested: string[] = [];
  fleet.eventBus.subscribe("lease.requested", (envelope) =>
    requested.push(envelope.payload.requestId),
  );
  const rejected: Array<EventMap["lease.rejected"]> = [];
  fleet.eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
  return { ...fleet, rejected, requested, runner };
}

describe("FleetLeaseCoordinator: the admission command decides each new request", () => {
  it("a gateway with an admission command queues a new request at the priority the command answers, and refuses it when the command denies or fails", async () => {
    const fleet = admissionFleet('{"deny":"budget used"}');

    const error = await fleet.coordinator
      .request(REQUEST, requestOptions())
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "ADMISSION_DENIED",
      details: { reason: "budget used" },
      message: "The gateway's admission policy refused this request: budget used",
    });
    expect(fleet.rejected).toEqual([
      expect.objectContaining({ reason: "admission-denied", requester: "agent-1" }),
    ]);
    expect(fleet.requested).toEqual([]);
    expect(fleet.runner.calls.map((call) => [call.command, ...call.args])).toEqual([[...COMMAND]]);
  });
});
