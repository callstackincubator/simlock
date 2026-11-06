import { describe, expect, it, vi } from "vitest";
import {
  PassthroughRefusedError,
  type PassthroughResolver,
  toDriverDevice,
} from "../core/index.js";
import {
  ExecOutputDeliveryStalledError,
  FakeClock,
  NodeProcessRunner,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../ports/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, flush, session } from "./test-dispatcher.js";

interface RecordedPassthrough {
  readonly args: readonly string[];
  readonly context: unknown;
  readonly device: unknown;
  readonly tool: string;
}

function recordingResolver(
  calls: RecordedPassthrough[],
  answer: () => Promise<unknown> = () =>
    Promise.resolve({ args: ["list", "devices"], command: "simctl", env: {} }),
): PassthroughResolver {
  const resolver = {
    passthrough: (tool: string, device: unknown, args: readonly string[], context?: unknown) => {
      calls.push({ args, context, device, tool });
      return answer();
    },
  };
  return resolver as unknown as PassthroughResolver;
}

describe("Dispatcher: device.exec", () => {
  const command = { args: ["--set", "/root", "list", "devices"], command: "simctl" };

  async function withLease(overrides: Parameters<typeof buildDispatcher>[0] = {}): Promise<{
    readonly dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"];
    readonly clock: FakeClock;
    readonly leaseId: string;
  }> {
    const built = await buildDispatcher({ passthroughTool: "simctl", ...overrides });
    const grant = await built.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_agent" }),
    );
    return {
      clock: built.clock,
      dispatcher: built.dispatcher,
      leaseId: (grant as { lease: { id: string } }).lease.id,
    };
  }

  it("runs the driver-resolved command and answers its exit code", async () => {
    const runner = new ScriptedProcessRunner([
      { match: command, result: { code: 3, stderr: "", stdout: "" } },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).resolves.toEqual({ exitCode: 3 });

    expect(runner.calls[0]).toMatchObject({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      options: { env: { PATH: "/usr/bin", SIMLOCK_SCOPED: "1" } },
    });
  });

  it("streams stdout and stderr chunks to the session in arrival order, unjoined", async () => {
    const runner = new ScriptedProcessRunner([
      {
        chunks: [
          { chunk: "first", stream: "stdout" },
          { chunk: "warning\n", stream: "stderr" },
          { chunk: " and second\n", stream: "stdout" },
        ],
        match: command,
      },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const seen: string[] = [];

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({
        onOutput: (stream, chunk) => {
          seen.push(`${stream}:${chunk}`);
        },
        principal: "tok_agent",
      }),
    );

    expect(seen).toEqual(["stdout:first", "stderr:warning\n", "stdout: and second\n"]);
  });

  it("spawns without a key of the daemon's environment that the command's unsetEnv names, and keeps every other key and the command's own env", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const resolver = recordingResolver([], () =>
      Promise.resolve({
        args: command.args,
        command: command.command,
        env: { SIMLOCK_SCOPED: "1" },
        unsetEnv: ["ANDROID_ADB_SERVER_ADDRESS", "ANDROID_SERIAL"],
      }),
    );
    const { dispatcher, leaseId } = await withLease({
      execEnv: {
        ANDROID_ADB_SERVER_ADDRESS: "other-host",
        ANDROID_SERIAL: "someone-elses-phone",
        PATH: "/usr/bin",
        UNRELATED: "kept",
      },
      passthroughOverride: resolver,
      processRunner: runner,
    });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    const env = runner.calls[0]?.options.env;
    expect(env).toEqual({ PATH: "/usr/bin", SIMLOCK_SCOPED: "1", UNRELATED: "kept" });
  });

  it("hands the request's stdin to the process runner as the command's input", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, stdin: "yes\n", tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(runner.calls[0]?.options.input).toBe("yes\n");
  });

  it("refuses stdin and stdinFile together with BAD_REQUEST and spawns nothing", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const calls: RecordedPassthrough[] = [];
    const { dispatcher, leaseId } = await withLease({
      passthroughOverride: recordingResolver(calls, () =>
        Promise.resolve({ args: ["--set", "/root", "list", "devices"], command: "simctl" }),
      ),
      processRunner: runner,
    });
    const run = (extra: Record<string, string>) =>
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl", ...extra },
        session({ principal: "tok_agent" }),
      );

    await expect(run({ stdin: "yes\n" })).resolves.toEqual({ exitCode: 0 });
    const spawned = runner.calls.length;
    const asked = calls.length;

    const refusal = await run({ stdin: "yes\n", stdinFile: "fixture.tar" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ message: "Give stdin or stdinFile, not both" });
    expect(classifyError(refusal)).toBe("BAD_REQUEST");
    expect(runner.calls).toHaveLength(spawned);
    expect(calls).toHaveLength(asked);
  });

  it("stops the command and fails with STDIN_FILE_FAILED when the stdinFile cannot be read to its end", async () => {
    const oneMiB = 1024 * 1024;
    for (const bytes of [oneMiB, 0]) {
      let closed = false;
      const runner = new ScriptedProcessRunner([{ hangs: true, match: command }]);
      const { dispatcher, leaseId } = await withLease({
        leaseFiles: {
          folderOf: () => Promise.resolve("/lease-folder"),
          openFile: (_grant, name) =>
            Promise.resolve({
              close: () => {
                closed = true;
                return Promise.resolve();
              },
              name,
              read: () => {
                let sent = 0;
                return new ReadableStream<Uint8Array>({
                  pull(controller) {
                    if (sent >= bytes) {
                      controller.error(new Error("disk went away"));
                      return;
                    }
                    controller.enqueue(new Uint8Array(bytes));
                    sent += bytes;
                  },
                });
              },
              size: bytes,
            }),
        },
        processRunner: runner,
      });

      let settled = false;
      const outcome = dispatcher
        .dispatch(
          "device.exec",
          { args: ["list", "devices"], leaseId, stdinFile: "fixture.tar", tool: "simctl" },
          session({ principal: "tok_agent" }),
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      await flush();
      expect(settled).toBe(true);
      const failure = await outcome;

      expect(classifyError(failure)).toBe("STDIN_FILE_FAILED");
      expect(failure).toMatchObject({
        details: { bytesRead: bytes, name: "fixture.tar" },
        message: `Reading fixture.tar failed after ${String(bytes)} bytes; the command was stopped`,
      });
      expect(closed).toBe(true);
    }
  });

  it("kills a command that outruns exec.timeoutMs and fails with EXEC_TIMEOUT", async () => {
    const runner = new ScriptedProcessRunner([{ hangs: true, match: command }]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    clock.advance(1_000);

    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("gates an agent session on the lease it owns, and refuses any requesterId it sends outright (round 4, F4)", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it("holds an admin session to the lease's requester instead of letting it bypass", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const admin = session({ principal: "gw:instance-1", role: "admin" });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        admin,
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it.each([
    { args: ["devices"], message: /No driver provides a adb passthrough/, tool: "adb" },
    { args: [], message: /No driver provides a bash passthrough/, tool: "bash" },
  ])(
    "refuses a tool no driver claims ($tool) with UNKNOWN_PASSTHROUGH_TOOL, not BAD_REQUEST",
    async ({ args, message, tool }) => {
      // why: a well-formed request for a wrapper this daemon has no driver for is not a malformed
      // one -- same distinction `driver.passthrough` draws, and the same error code.
      const runner = new ScriptedProcessRunner([]);
      const { dispatcher, leaseId } = await withLease({ processRunner: runner });

      const error = await dispatcher
        .dispatch("device.exec", { args, leaseId, tool }, session({ principal: "tok_agent" }))
        .then(
          () => undefined,
          (rejected: unknown) => rejected,
        );

      expect(classifyError(error)).toBe("UNKNOWN_PASSTHROUGH_TOOL");
      expect((error as Error).message).toMatch(message);
      expect(runner.calls).toEqual([]);
    },
  );

  it("passes the lease's driver device to passthrough for device.exec and no device for driver.passthrough", async () => {
    const calls: RecordedPassthrough[] = [];
    const built = await buildDispatcher({
      passthroughOverride: recordingResolver(calls),
      processRunner: new ScriptedProcessRunner([
        { match: { args: ["list", "devices"], command: "simctl" } },
      ]),
    });
    const grant = (await built.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_agent" }),
    )) as { lease: { id: string } };
    const lease = built.registry.snapshot.leases.find(
      (candidate) => candidate.id === grant.lease.id,
    );
    const record = built.registry.snapshot.devices.find((device) => device.id === lease?.deviceId);
    if (record === undefined) throw new Error("granted device is not in the registry");

    const settled = await Promise.allSettled([
      built.dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: grant.lease.id, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
      built.dispatcher.dispatch(
        "driver.passthrough",
        { args: ["list", "devices"], tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ]);

    expect(calls.map((call) => call.device)).toEqual([toDriverDevice(record), undefined]);
    expect(calls[0]?.device).toMatchObject({ deviceId: record.driverDeviceId, physical: false });
    expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("answers PASSTHROUGH_REFUSED on device.exec and driver.passthrough when passthrough rejects, and device.exec spawns nothing", async () => {
    const calls: RecordedPassthrough[] = [];
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({
      passthroughOverride: recordingResolver(calls, () =>
        Promise.reject(new PassthroughRefusedError("devicectl", "Refusing `simlock devicectl`.")),
      ),
      processRunner: runner,
    });

    const exec = await dispatcher
      .dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "devicectl" },
        session({ principal: "tok_agent" }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const direct = await dispatcher
      .dispatch(
        "driver.passthrough",
        { args: ["list", "devices"], tool: "devicectl" },
        session({ principal: "tok_agent" }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(calls.map((call) => call.tool)).toEqual(["devicectl", "devicectl"]);
    expect(exec).toBeInstanceOf(PassthroughRefusedError);
    expect(classifyError(exec)).toBe("PASSTHROUGH_REFUSED");
    expect(direct).toBeInstanceOf(PassthroughRefusedError);
    expect(classifyError(direct)).toBe("PASSTHROUGH_REFUSED");
    expect(runner.calls).toEqual([]);
  });

  it("answers UNKNOWN_LEASE and resolves no command when device.exec names no lease", async () => {
    const calls: RecordedPassthrough[] = [];
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher } = await withLease({
      passthroughOverride: recordingResolver(calls),
      processRunner: runner,
    });

    const error = await dispatcher
      .dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: "lse_gone", tool: "simctl" },
        session({ principal: "tok_agent" }),
      )
      .then(
        () => undefined,
        (rejected: unknown) => rejected,
      );

    expect(classifyError(error)).toBe("UNKNOWN_LEASE");
    expect((error as Error).message).toMatch(/Unknown lease: lse_gone/);
    expect(calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("answers UNKNOWN_LEASE and resolves no command when the lease's device record is gone", async () => {
    const calls: RecordedPassthrough[] = [];
    const runner = new ScriptedProcessRunner([]);
    const built = await buildDispatcher({
      passthroughOverride: recordingResolver(calls),
      processRunner: runner,
    });
    const grant = (await built.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_agent" }),
    )) as { lease: { id: string } };
    const snapshot = built.registry.snapshot;
    expect(snapshot.leases.map((lease) => lease.id)).toEqual([grant.lease.id]);
    vi.spyOn(built.registry, "snapshot", "get").mockReturnValue({ ...snapshot, devices: [] });

    const error = await built.dispatcher
      .dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: grant.lease.id, tool: "simctl" },
        session({ principal: "tok_agent" }),
      )
      .then(
        () => undefined,
        (rejected: unknown) => rejected,
      );

    expect(classifyError(error)).toBe("UNKNOWN_LEASE");
    expect(calls).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("tells the driver there is no terminal, so it can refuse what needs one", async () => {
    const seen: unknown[] = [];
    const { dispatcher, leaseId } = await withLease({
      passthroughContextSink: seen,
      processRunner: new ScriptedProcessRunner([{ match: command }]),
    });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await dispatcher.dispatch(
      "driver.passthrough",
      { args: ["list", "devices"], tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(seen).toEqual([{ hasTerminal: false, platform: "ios" }, undefined]);
  });

  it("escalates to SIGKILL when a timed-out command ignores SIGTERM", async () => {
    const runner = new ScriptedProcessRunner([
      { hangs: true, ignoresSigterm: true, match: command },
    ]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    let settled = false;
    void pending.catch(() => (settled = true));

    clock.advance(1_000);
    await flush();
    expect(settled).toBe(false);

    clock.advance(10_000);
    await flush();
    expect(settled).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("resolves with the exit code, not EXEC_TIMEOUT, when the command finishes before the timeout timer's callback runs -- even scheduled in the same synchronous burst", async () => {
    // why: `Promise.race([waited, expired])` -- not a flag either callback sets -- is what this
    // proves the value of: `handle.finish(7)` and `clock.advance(1_000)` are both called here
    // synchronously, one right after the other, with nothing in between observing either
    // settle. A flag-based implementation (`let timedOut = false; timer sets it`) would be at
    // the mercy of which of these two statements a maintainer wrote first, and get it wrong
    // for whichever settles second; `Promise.race` instead answers from whichever promise
    // *actually* settled first, in the order the two calls below run it -- unaffected by which
    // of `waited`/`expired` the `Promise.race([...])` array happens to list first.
    const clock = new FakeClock(1_000);
    const handle = new SettleOnCueHandle();
    const { dispatcher, leaseId } = await withLease({
      clock,
      exec: { timeoutMs: 1_000 },
      processRunner: { spawnStreaming: () => handle } as unknown as ProcessRunner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();

    handle.finish(7);
    clock.advance(1_000);

    await expect(pending).resolves.toEqual({ exitCode: 7 });
    expect(handle.signals).toEqual([]);
  });

  describe("output delivered across a real exit, against a real NodeProcessRunner", () => {
    // why: `ScriptedProcessRunner` can't reproduce this class of defect: its scripted handle always
    // awaits a chunk's delivery before it will settle at all, so it cannot model "the child has
    // already exited and closed its pipe while a chunk's delivery to a slow consumer is still
    // outstanding" -- exactly the state a real OS pipe can be in (verified against real Node:
    // `close` can fire in the same tick as the `data` event for a chunk this process runner
    // just paused on). `#deviceExec` (`server.ts`) and the HTTP exec route (`app.ts`) both just
    // hand their transport's own backpressured `onOutput` straight to this same dispatcher
    // call, so a real reproduction here against a real child process is the one place this
    // defect -- and its fix, in `NodeStreamingProcessHandle` -- is actually exercised, for
    // both transports at once.
    function realCommand(script: string): PassthroughResolver {
      return recordingResolver([], () =>
        Promise.resolve({ args: ["-e", script], command: process.execPath, env: {} }),
      );
    }
    // why: the 30 s per-test timeouts below are hang guards, not speed claims: the stalled-delivery
    // cases pass a 100 ms exit deferral cap to the real runner instead of waiting out its 5 s
    // default, and a short guard would leave one slow child-process spawn on a busy machine
    // between it and a false failure.

    it("delivers every chunk in full, in order, even when one delivery stalls past the exit grace window", async () => {
      const seen: string[] = [];
      let releaseFirst!: () => void;
      const firstDelivery = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const { dispatcher, leaseId } = await withLease({
        passthroughOverride: realCommand(
          "process.stdout.write('before-exit-A');" +
            "setTimeout(() => { process.stdout.write('before-exit-B'); process.exit(0); }, 20);",
        ),
        processRunner: new NodeProcessRunner({ exitGraceMs: 300 }),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: (_stream, chunk) => {
            seen.push(chunk);
            // why: only the first chunk's delivery stalls, past the 300 ms exit grace window
            // this handle used to settle on regardless.
            return seen.length === 1 ? firstDelivery : undefined;
          },
          principal: "tok_agent",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 600));
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        settledEarly,
        "device.exec resolved while a chunk's delivery was still pending -- output after it may have been dropped",
      ).toBe(false);

      releaseFirst();
      await expect(pending).resolves.toEqual({ exitCode: 0 });
      expect(seen).toEqual(["before-exit-A", "before-exit-B"]);
    }, 30_000);

    it("fails device.exec loudly, rather than answering a truncated exit code, when a chunk's delivery never resolves", async () => {
      const { dispatcher, leaseId } = await withLease({
        passthroughOverride: realCommand("process.stdout.write('stuck'); process.exit(0);"),
        processRunner: new NodeProcessRunner({ exitDeferralCapMs: 100 }),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: () =>
            new Promise<void>(() => {
              // why: A consumer whose backpressure never clears -- a dead SSE write, a socket that
              // never drains.
            }),
          principal: "tok_agent",
        }),
      );

      await expect(pending).rejects.toThrow(ExecOutputDeliveryStalledError);
    }, 30_000);

    it("reports EXEC_TIMEOUT, not the stalled-delivery error it provokes, when a consumer that stopped reading is why the command outran its timeout", async () => {
      const { clock, dispatcher, leaseId } = await withLease({
        exec: { timeoutMs: 50 },
        passthroughOverride: realCommand("process.stdout.write('x'); setInterval(() => {}, 1000);"),
        processRunner: new NodeProcessRunner({ exitDeferralCapMs: 100 }),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: () =>
            new Promise<void>(() => {
              // why: Never resolves: the stream is paused on this chunk's delivery for the rest
              // of the test, exactly as a client that opened the stream and stopped reading
              // would leave it.
            }),
          principal: "tok_agent",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      clock.advance(50);

      await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
    }, 30_000);
  });
});

class SettleOnCueHandle {
  readonly pid = 99;
  readonly signals: string[] = [];
  #resolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly #result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      this.#resolve = resolve;
    },
  );

  finish(code: number): void {
    this.#resolve({ code, signal: null });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#result;
  }
}

describe("Dispatcher: device.add and device.remove", () => {
  const admin = () => session({ principal: "tok_operator", role: "admin" });
  const UDID = "00008110-001A2B3C4D5E";

  async function withEnrollment() {
    return buildDispatcher({
      driverOptions: {
        physicalDevices: [
          {
            apps: ["a", "b"],
            class: "tablet",
            ids: [UDID, "ALIAS"],
            model: "iPad",
            osVersion: "18.5",
          },
          { ids: ["LOCKED"], refusal: { message: "locked: unlock it", reason: "locked" } },
        ],
      },
      includeEnrollment: true,
    });
  }

  it("enrolls a device, answering with the registry ID, the canonical ID and what was read, and removes it by its canonical ID", async () => {
    const { dispatcher, registry } = await withEnrollment();

    const added = await dispatcher.dispatch(
      "device.add",
      { id: "ALIAS", platform: "ios" },
      admin(),
    );
    const removed = await dispatcher.dispatch("device.remove", { id: UDID }, admin());

    expect(added).toEqual({
      appCount: 2,
      class: "tablet",
      driverDeviceId: UDID,
      id: registry.snapshot.devices[0]?.id,
      model: "iPad",
      osVersion: "18.5",
      platform: "ios",
      reenrolled: false,
    });
    expect(removed).toEqual({ driverDeviceId: UDID, id: registry.snapshot.devices[0]?.id });
    expect(registry.snapshot.devices[0]?.state).toBe("deleted");
  });

  it("answers a refusal as DEVICE_NOT_ENROLLABLE with the ID as typed, the platform, the reason and the driver's message", async () => {
    const { dispatcher } = await withEnrollment();

    const refusal = dispatcher.dispatch("device.add", { id: "LOCKED", platform: "ios" }, admin());

    await expect(refusal).rejects.toMatchObject({
      code: "DEVICE_NOT_ENROLLABLE",
      details: { id: "LOCKED", platform: "ios", reason: "locked" },
      message: "locked: unlock it",
    });
    await expect(refusal).rejects.not.toHaveProperty("details.canonicalId");
  });

  it("carries the canonical ID of a refusal of the second read", async () => {
    const { dispatcher, driver } = await withEnrollment();
    await dispatcher.dispatch("device.add", { id: UDID, platform: "ios" }, admin());
    const original = driver.inspectPhysical.bind(driver);
    let calls = 0;
    vi.spyOn(driver, "inspectPhysical").mockImplementation(async (id) => {
      calls += 1;
      return calls === 1
        ? original(id)
        : { enrollable: false, message: "locked: unlock it", reason: "locked" };
    });

    await expect(
      dispatcher.dispatch("device.add", { id: "ALIAS", platform: "ios" }, admin()),
    ).rejects.toMatchObject({
      code: "DEVICE_NOT_ENROLLABLE",
      details: { canonicalId: UDID, id: "ALIAS", platform: "ios", reason: "locked" },
    });
  });

  it("answers a leased device as DEVICE_BUSY with its ID and reason, and an unknown one as UNKNOWN_DEVICE", async () => {
    const { dispatcher, registry } = await withEnrollment();
    const { id } = await dispatcher.dispatch("device.add", { id: UDID, platform: "ios" }, admin());
    await registry.createLease({
      deviceId: id,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: 61_000,
      ttlMs: 60_000,
    });

    await expect(dispatcher.dispatch("device.remove", { id: UDID }, admin())).rejects.toMatchObject(
      {
        code: "DEVICE_BUSY",
        details: { id: UDID, reason: "leased" },
        message: `${UDID} is leased: release it first`,
      },
    );
    await expect(
      dispatcher.dispatch("device.remove", { id: "NOPE" }, admin()),
    ).rejects.toMatchObject({
      code: "UNKNOWN_DEVICE",
      details: { id: "NOPE" },
      message: "NOPE is not an enrolled device",
    });
  });

  it("passes a driver that throws on as the error it is, and answers INTERNAL on a daemon with no enrollment", async () => {
    const { dispatcher, driver } = await withEnrollment();
    driver.failOn("inspectPhysical", 1, new Error("usbmuxd went away"));
    const without = await buildDispatcher();

    const failure: unknown = await dispatcher
      .dispatch("device.add", { id: UDID, platform: "ios" }, admin())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: `Reading ${UDID} failed: usbmuxd went away`,
      name: "PhysicalInspectionError",
    });
    await expect(
      without.dispatcher.dispatch("device.add", { id: UDID, platform: "ios" }, admin()),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "Device enrollment is unavailable" });
    await expect(
      without.dispatcher.dispatch("device.remove", { id: UDID }, admin()),
    ).rejects.toMatchObject({ code: "INTERNAL", message: "Device enrollment is unavailable" });
  });

  it("refuses an agent session with FORBIDDEN and never asks the driver", async () => {
    const { dispatcher, driver } = await withEnrollment();

    await expect(
      dispatcher.dispatch("device.add", { id: UDID, platform: "ios" }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("device.remove", { id: UDID }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(driver.calls.filter((call) => call.operation === "inspectPhysical")).toEqual([]);
  });
});
