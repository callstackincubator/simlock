import { describe, expect, it } from "vitest";
import type { EventMap } from "../bus/index.js";
import {
  ProcessSpawnError,
  ScriptedProcessRunner,
  type ProcessRunOptions,
  type ProcessResult,
} from "../ports/index.js";
import {
  GATEWAY_PREFIX,
  RecordingLogger,
  REQUEST,
  connectWorker,
  harness,
  requestOptions,
  roomierIos,
  saturatedIos,
  tick,
} from "./test-fleet.js";
import { ScriptedWorkerClient, grantFixture, physicalDeviceFixture } from "./test-support.js";

const COMMAND = ["bun", "/etc/simlock/policy.ts"] as const;
const FAILED = "ADMISSION_FAILED";
const NOT_AN_ANSWER = "printed an answer that is not a priority or a refusal";
const denied = (reason: string) => ({ code: "ADMISSION_DENIED", details: { reason } });
const refusal = (reason: string) => ({ stdout: JSON.stringify({ deny: reason }) });

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

function admissionFleet(output: Output, command: readonly string[] = COMMAND) {
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
  const fleet = harness({ admission: { command, runner, timeoutMs: 5_000 }, logger });
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

/** why: a runner whose commands answer only when the test says, as a slow policy script does. */
class GatedRunner extends ScriptedProcessRunner {
  readonly #open: Array<(stdout: string) => void> = [];
  constructor() {
    super([]);
  }
  override run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({ args: [...args], command, options });
    return new Promise((resolve) => {
      this.#open.push((stdout) => resolve({ code: 0, stderr: "", stdout }));
      options.signal?.addEventListener(
        "abort",
        () =>
          resolve({ code: null, endedBy: "aborted", signal: "SIGKILL", stderr: "", stdout: "" }),
        { once: true },
      );
    });
  }
  answer(index: number, stdout: string): void {
    this.#open[index]?.(stdout);
  }
}

/** why: every command answers `{}` at once; the worker has room, so a request is granted and a refused one never reaches it. */
function grantingFleet(runner: ScriptedProcessRunner) {
  const logger = new RecordingLogger();
  const fleet = harness({ admission: { command: COMMAND, runner, timeoutMs: 5_000 }, logger });
  const client = new ScriptedWorkerClient();
  fleet.directory.add("wrk_a", client);
  connectWorker(fleet.workers, "wrk_a");
  return { ...fleet, client, logger, runner };
}

function gatedFleet() {
  const runner = new GatedRunner();
  const fleet = grantingFleet(runner);
  const requested: string[] = [];
  fleet.eventBus.subscribe("lease.requested", (envelope) =>
    requested.push(envelope.payload.requestId),
  );
  const rejected: Array<EventMap["lease.rejected"]> = [];
  fleet.eventBus.subscribe("lease.rejected", (envelope) => rejected.push(envelope.payload));
  return { ...fleet, rejected, requested, runner };
}

const answering = (count: number) =>
  new ScriptedProcessRunner(
    Array.from({ length: count }, () => ({
      match: { args: [COMMAND[1]], command: COMMAND[0] },
      result: { code: 0, stderr: "", stdout: "{}" },
    })),
  );

describe("FleetLeaseCoordinator: the admission command decides each new request", () => {
  it("a gateway with an admission command queues a new request at the priority the command answers, and refuses it when the command denies or fails", async () => {
    const queued = { queued: true };
    const failed = (cause: string) => ({ code: FAILED, details: { cause } });
    const longProgram = "p".repeat(501);
    const rows: ReadonlyArray<{
      readonly output: Output;
      readonly expected: object;
      readonly command?: readonly string[];
    }> = [
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
      {
        expected: failed("killed after 5000 ms"),
        output: { code: null, endedBy: "timeout", signal: "SIGKILL" },
      },
      {
        expected: failed("printed more than 65536 bytes"),
        output: {
          code: null,
          endedBy: "output-limit",
          signal: "SIGKILL",
          stdout: '{"priority":1}',
        },
      },
      { expected: failed("killed by signal SIGKILL"), output: { code: null, signal: "SIGKILL" } },
      { expected: failed("could not start bun"), output: "cannot-start" },
      {
        expected: { code: "ADMISSION_DENIED", details: { reason: "budget used" } },
        output: { stdout: '{"deny":"budget used"}' },
      },
      { expected: denied("x".repeat(500)), output: refusal("x".repeat(500)) },
      { expected: failed(NOT_AN_ANSWER), output: refusal("x".repeat(501)) },
      { expected: denied("a b"), output: refusal("a b") },
      { expected: failed(NOT_AN_ANSWER), output: refusal("a\u0001b") },
      { expected: failed(NOT_AN_ANSWER), output: refusal("a\u007fb") },
      {
        command: [longProgram],
        expected: failed(`could not start ${"p".repeat(500)}`),
        output: "cannot-start",
      },
    ];

    for (const { output, expected, command } of rows) {
      const fleet = admissionFleet(output, command);
      const request = fleet.coordinator.request(REQUEST, requestOptions());
      let refusal: { code: string; details: unknown } | undefined;
      request.catch((error: { code: string; details: unknown }) => {
        refusal = { code: error.code, details: error.details };
      });
      await tick();
      const outcome = refusal ?? {
        queued: fleet.coordinator.waitingRequests().map((entry) => entry.stage),
      };
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

    expect(fleet.runner.calls[0]?.options.maxStdoutBytes).toBe(65_536);

    const noisy = admissionFleet({ code: 1, stderr: "e".repeat(3000), stdout: "" });
    await noisy.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    expect(noisy.logger.warnings[0]?.fields).toMatchObject({ stderr: "e".repeat(2048) });

    const held = grantingFleet(answering(1));
    held.client.requestLeaseQueue.push({
      grant: grantFixture({ lease: { ...grantFixture().lease, id: "myid" } }),
      kind: "grant",
    });
    await held.coordinator.request(REQUEST, requestOptions({ leaseId: "myid" }));
    const taken = await held.coordinator
      .request(
        REQUEST,
        requestOptions({ leaseId: "myid", ownerId: "agent-2", requesterId: "agent-2" }),
      )
      .catch((error: { code?: string }) => error.code);
    const limited = await held.coordinator
      .request(REQUEST, requestOptions())
      .catch((error: { name?: string }) => error.name);
    expect([taken, limited]).toEqual(["LEASE_ID_TAKEN", "RequesterAlreadyLeasedError"]);
    expect(held.runner.calls).toHaveLength(1);
  });

  it("a request the gateway already holds is answered without running the command", async () => {
    const granted = grantingFleet(answering(1));
    granted.client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    const first = await granted.coordinator.request(
      REQUEST,
      requestOptions({ idempotencyKey: "k" }),
    );
    const repeat = await granted.coordinator.request(
      REQUEST,
      requestOptions({ idempotencyKey: "k" }),
    );
    expect(repeat).toEqual(first);
    expect(granted.runner.calls).toHaveLength(1);

    const runner = new GatedRunner();
    const fleet = grantingFleet(runner);
    connectWorker(fleet.workers, "wrk_a", { capacity: saturatedIos() });
    const asked = [0, 1].map(() =>
      fleet.coordinator.request(REQUEST, requestOptions({ idempotencyKey: "k" })),
    );
    asked.forEach((request) => request.catch(() => undefined));
    await tick();
    expect(runner.calls).toHaveLength(2);
    runner.answer(0, '{"priority":5}');
    await tick();
    runner.answer(1, '{"deny":"budget used"}');
    await tick();
    expect(fleet.coordinator.waitingRequests()).toHaveLength(1);
    void fleet.coordinator.request(REQUEST, requestOptions({ idempotencyKey: "k" }));
    await tick();
    expect(runner.calls).toHaveLength(2);
    const rejected = fleet.eventBus.replay().filter((event) => event.event === "lease.rejected");
    expect(rejected).toEqual([]);
  });

  it("waiting requests on one gateway line are served by priority, then arrival", async () => {
    const arrivals = [
      { name: "A", priority: 0 },
      { name: "B", priority: 10 },
      { name: "C", priority: 0 },
      { name: "D", priority: 10 },
      { name: "P", physical: true, priority: 0 },
      { name: "Q", physical: true, priority: 5 },
    ];
    const runner = new ScriptedProcessRunner(
      arrivals.map(({ priority }) => ({
        match: { args: [COMMAND[1]], command: COMMAND[0] },
        result: { code: 0, stderr: "", stdout: JSON.stringify({ priority }) },
      })),
    );
    const fleet = harness({ admission: { command: COMMAND, runner, timeoutMs: 5_000 } });
    const client = new ScriptedWorkerClient();
    fleet.directory.add("wrk_a", client);
    const busy = {
      capacity: saturatedIos(),
      devices: [
        physicalDeviceFixture("dev_p", "ready", {
          presence: { present: false, reason: "not-present" },
        }),
      ],
    };
    connectWorker(fleet.workers, "wrk_a", busy);
    const queued: number[] = [];
    fleet.eventBus.subscribe("lease.queued", (envelope) =>
      queued.push(envelope.payload.queuePosition),
    );
    const pushed: Record<string, number[]> = {};

    for (const { name, physical } of arrivals) {
      pushed[name] = [];
      void fleet.coordinator
        .request(
          physical === true
            ? { ...REQUEST, model: "iPhone 15 Pro", osVersion: "18.4", physical }
            : REQUEST,
          requestOptions({
            onProgress: (progress) => {
              if (progress.stage === "queued") pushed[name]?.push(progress.queuePosition);
            },
            ownerId: name,
            requesterId: name,
          }),
        )
        .catch(() => undefined);
      await tick();
    }

    expect(pushed).toEqual({ A: [1], B: [1], C: [3], D: [2], P: [1], Q: [1] });
    expect(queued).toEqual([1, 1, 3, 2, 1, 1]);
    const waiting = fleet.coordinator.waitingRequests();
    expect(
      Object.fromEntries(waiting.map((entry) => [entry.requesterId, entry.queuePosition])),
    ).toEqual({ A: 3, B: 1, C: 4, D: 2, P: 2, Q: 1 });

    for (const name of ["B", "D", "A", "C"]) {
      client.requestLeaseQueue.push({
        grant: grantFixture({ lease: { ...grantFixture().lease, id: `lse_${name}` } }),
        kind: "grant",
      });
    }
    fleet.workers.refresh("wrk_a", { capacity: roomierIos() });
    await tick();
    expect(client.calls.filter((call) => call.startsWith("lease.request"))).toEqual(
      ["B", "D", "A", "C"].map((name) => `lease.request:${GATEWAY_PREFIX}${name}`),
    );
  });

  it("a caller that cancels, or a gateway that stops, while the command runs ends the request and the command", async () => {
    const stopped = { code: "DAEMON_STOPPING" };
    const cancelled = { name: "RequestCancelledError" };
    const cases = [
      {
        end: (fleet: ReturnType<typeof gatedFleet>) => fleet.coordinator.cancelPending("agent-1"),
        expectedError: cancelled,
        name: "lease.cancel",
        rejected: ["cancelled"],
      },
      {
        end: (fleet: ReturnType<typeof gatedFleet>) => fleet.coordinator.dispose(),
        expectedError: stopped,
        name: "the gateway stops",
        rejected: [],
      },
    ];

    for (const { end, expectedError, name, rejected } of cases) {
      for (const early of [false, true]) {
        const label = `${name}${early ? " sent right after the request" : ""}`;
        const fleet = gatedFleet();
        let error: unknown;
        fleet.coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => (error = e));
        if (!early) {
          await tick();
          expect(fleet.runner.calls, label).toHaveLength(1);
        }

        const answer = await end(fleet);
        await tick();

        expect(answer, label).toBe(name === "lease.cancel" ? "cancelled" : undefined);
        expect(error, label).toMatchObject(expectedError);
        if (!early) expect(fleet.runner.calls[0]?.options.signal?.aborted, label).toBe(true);
        else expect(fleet.runner.calls, label).toEqual([]);
        fleet.runner.answer(0, "{}");
        await tick();
        expect(fleet.requested, label).toEqual([]);
        expect(fleet.coordinator.waitingRequests(), label).toEqual([]);
        expect(
          fleet.rejected.map((event) => event.reason),
          label,
        ).toEqual(rejected);
        expect(fleet.logger.warnings, label).toEqual([]);
      }
    }

    const answered = gatedFleet();
    answered.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    answered.runner.answer(0, '{"priority":1}');
    await tick();
    expect(await answered.coordinator.cancelPending("agent-1")).toBe("cancelled");
    expect(answered.rejected.map((event) => event.reason)).toEqual(["cancelled"]);
    expect(answered.runner.calls[0]?.options.signal?.aborted).toBe(false);

    const other = gatedFleet();
    other.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    const strangers = [
      await other.coordinator.cancelPending("agent-2"),
      await other.coordinator.cancelPending("agent-1", "android"),
    ];
    expect(strangers).toEqual(["not-found", "not-found"]);
    expect(other.runner.calls[0]?.options.signal?.aborted).toBe(false);
  });
});
