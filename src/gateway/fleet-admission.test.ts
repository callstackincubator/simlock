import { describe, expect, it } from "vitest";
import type { EventMap } from "../bus/index.js";
import {
  ProcessSpawnError,
  ScriptedProcessRunner,
  type ProcessRunOptions,
  type ProcessResult,
} from "../ports/index.js";
import { promiseState } from "../test-support/promise-state.js";
import {
  RecordingLogger,
  REQUEST,
  connectWorker,
  harness,
  requestOptions,
  saturatedIos,
  tick,
} from "./test-fleet.js";
import { ScriptedWorkerClient } from "./test-support.js";

const COMMAND = ["bun", "/etc/simlock/policy.ts"] as const;
const FAILED = "ADMISSION_FAILED";
const NOT_AN_ANSWER = "printed an answer that is not a priority or a refusal";

type Output = Partial<ProcessResult> | "cannot-start";

/** why: a runner whose one program does not exist, as a real spawn of a missing binary fails. */
class MissingProgramRunner extends ScriptedProcessRunner {
  constructor() {
    super([]);
  }
  override run(
    command: string,
    args: readonly string[],
    _options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return Promise.reject(new ProcessSpawnError(command, args));
  }
}

function admissionFleet(output: Output) {
  const runner =
    output === "cannot-start"
      ? new MissingProgramRunner()
      : new ScriptedProcessRunner([
          {
            match: { args: [COMMAND[1]], command: COMMAND[0] },
            result: { code: 0, stderr: "", stdout: "", ...output },
          },
        ]);
  const logger = new RecordingLogger();
  const fleet = harness({ admission: { command: COMMAND, runner, timeoutMs: 5_000 }, logger });
  const client = new ScriptedWorkerClient();
  fleet.directory.add("wrk_a", client);
  connectWorker(fleet.workers, "wrk_a", { capacity: saturatedIos() });
  const requested: string[] = [];
  fleet.eventBus.subscribe("lease.requested", (envelope) =>
    requested.push(envelope.payload.requestId),
  );
  const rejected: Array<EventMap["lease.rejected"]> = [];
  fleet.eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
  return { ...fleet, logger, rejected, requested, runner };
}

describe("FleetLeaseCoordinator: the admission command decides each new request", () => {
  it("a gateway with an admission command queues a new request at the priority the command answers, and refuses it when the command denies or fails", async () => {
    const queued = { queued: true };
    const failed = (cause: string) => ({ code: FAILED, details: { cause } });
    const rows: ReadonlyArray<{ readonly output: Output; readonly expected: object }> = [
      { expected: queued, output: { stdout: '{"priority":10}' } },
      { expected: queued, output: { stdout: "{}" } },
      { expected: queued, output: { stdout: ' \n{"priority":-1000}\n' } },
      { expected: queued, output: { stdout: '{"priority":1000}' } },
      { expected: queued, output: { stdout: '{"priority":1,"extra":true}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: '{"priority":1001}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: '{"priority":2.5}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: '{"priority":"10"}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: '{"deny":""}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: '{"priority":1,"deny":"x"}' } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: "not json" } },
      { expected: failed(NOT_AN_ANSWER), output: { stdout: "{}{}" } },
      { expected: failed("printed no answer"), output: { stdout: "  \n" } },
      { expected: failed("exited 1"), output: { code: 1, stdout: '{"priority":1}' } },
      { expected: failed("could not start bun"), output: "cannot-start" },
      {
        expected: { code: "ADMISSION_DENIED", details: { reason: "budget used" } },
        output: { stdout: '{"deny":"budget used"}' },
      },
    ];

    for (const { output, expected } of rows) {
      const fleet = admissionFleet(output);
      const request = fleet.coordinator.request(REQUEST, requestOptions());
      const settled = request.then(
        () => ({ granted: true }),
        (error: { code: string; details: unknown }) => ({
          code: error.code,
          details: error.details,
        }),
      );
      await tick();
      const outcome =
        promiseState(request).state === "pending"
          ? { queued: fleet.coordinator.waitingRequests().map((entry) => entry.stage) }
          : await settled;
      expect(outcome, JSON.stringify(output)).toEqual(
        "queued" in expected ? { queued: ["queued"] } : expected,
      );
    }

    const fleet = admissionFleet({ code: 1, stderr: "policy.ts: no budget file\n", stdout: "" });

    await fleet.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);

    expect(fleet.rejected).toEqual([expect.objectContaining({ reason: "admission-failed" })]);
    expect(fleet.requested).toEqual([]);
    expect(fleet.logger.warnings).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          cause: "exited 1",
          stderr: "policy.ts: no budget file\n",
        }) as unknown,
      }),
    ]);
  });
});
