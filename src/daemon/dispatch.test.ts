import { describe, expect, it } from "vitest";

import { FakeClock, JsonLinesLogger, MemoryLogSink, type LogLevel } from "../ports/index.js";
import {
  DispatchError,
  runDispatch,
  type DispatchPipeline,
  type DispatchSession,
  type ErasedHandler,
} from "./dispatch.js";

function harness(handlers: DispatchPipeline["handlers"], level: LogLevel = "debug") {
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const logger = new JsonLinesLogger({ clock, level, module: "dispatch", sink });
  const pipeline: DispatchPipeline = {
    handlers,
    observe: {
      clock,
      logger,
      codeOf: (error) => (error instanceof DispatchError ? error.code : "INTERNAL"),
    },
  };
  return { clock, pipeline, sink };
}

function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => undefined,
    principal: "agent-7",
    role: "agent",
    ...overrides,
  };
}

/** A handler that takes `ms` of fake time and then answers `output`. */
function slow(clock: FakeClock, ms: number, output: unknown): ErasedHandler {
  return () => {
    clock.advance(ms);
    return output;
  };
}

describe("runDispatch's operation line", () => {
  it("a write that succeeds logs one info line with the operation, principal, role and duration", async () => {
    const handlers: DispatchPipeline["handlers"] = {};
    const { clock, pipeline, sink } = harness(handlers);
    handlers["lease.release"] = slow(clock, 40, { leaseId: "lse_1" });

    await runDispatch("lease.release", { leaseId: "lse_1" }, session(), pipeline);

    expect(sink.records).toEqual([
      {
        timestamp: 1_040,
        level: "info",
        module: "dispatch",
        message: "operation",
        fields: {
          operation: "lease.release",
          principal: "agent-7",
          role: "agent",
          durationMs: 40,
          leaseId: "lse_1",
        },
      },
    ]);
  });

  it("a read that succeeds logs at debug and nothing at info", async () => {
    const handlers: DispatchPipeline["handlers"] = { "lease.list": () => ({ leases: [] }) };
    const debug = harness(handlers, "debug");
    const info = harness(handlers, "info");

    await runDispatch("lease.list", {}, session(), debug.pipeline);
    await runDispatch("lease.list", {}, session(), info.pipeline);

    expect(debug.sink.records).toEqual([
      expect.objectContaining({
        level: "debug",
        message: "operation",
        fields: expect.objectContaining({ operation: "lease.list" }),
      }),
    ]);
    expect(info.sink.records).toEqual([]);
  });

  it("a read that fails logs at info with its error code", async () => {
    const { pipeline, sink } = harness(
      {
        "lease.list": () => {
          throw new DispatchError("UNKNOWN_LEASE", "no such lease");
        },
      },
      "info",
    );

    await expect(runDispatch("lease.list", {}, session(), pipeline)).rejects.toThrow(
      "no such lease",
    );

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "operation",
        fields: expect.objectContaining({
          operation: "lease.list",
          code: "UNKNOWN_LEASE",
          message: "no such lease",
        }),
      }),
    ]);
  });

  it("an error classified INTERNAL logs at error", async () => {
    const { pipeline, sink } = harness({
      "lease.release": () => {
        throw new Error("registry exploded");
      },
    });

    await expect(
      runDispatch("lease.release", { leaseId: "lse_1" }, session(), pipeline),
    ).rejects.toThrow("registry exploded");

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "error",
        message: "operation",
        fields: expect.objectContaining({ code: "INTERNAL", message: "registry exploded" }),
      }),
    ]);
  });

  it("a request refused for its role logs one line with FORBIDDEN", async () => {
    let called = false;
    const { pipeline, sink } = harness({
      "nuke.run": () => {
        called = true;
        return {};
      },
    });

    await expect(runDispatch("nuke.run", {}, session(), pipeline)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(called).toBe(false);
    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "info",
        message: "operation",
        fields: expect.objectContaining({
          operation: "nuke.run",
          code: "FORBIDDEN",
          role: "agent",
        }),
      }),
    ]);
  });

  it("the line carries leaseId and requesterId from the validated input and no other input field", async () => {
    const { pipeline, sink } = harness({
      "lease.request": () => {
        throw new DispatchError("NO_CAPACITY", "full");
      },
      "device.exec": () => {
        throw new DispatchError("UNKNOWN_LEASE", "gone");
      },
      "lease.renew": () => {
        throw new Error("never reached: the input is refused first");
      },
    });

    await expect(
      runDispatch(
        "lease.request",
        { model: "iPhone 17", platform: "ios", requesterId: "agent-session-9", ttlMs: 60_000 },
        session(),
        pipeline,
      ),
    ).rejects.toThrow("full");
    await expect(
      runDispatch(
        "device.exec",
        { args: ["shell", "echo", "s3cret"], leaseId: "lse_4", tool: "adb" },
        session(),
        pipeline,
      ),
    ).rejects.toThrow("gone");

    const common = ["code", "durationMs", "message", "operation", "principal", "role"];
    expect(Object.keys(sink.records[0]?.fields ?? {}).sort()).toEqual(
      [...common, "requesterId"].sort(),
    );
    expect(sink.records[0]?.fields).toMatchObject({ requesterId: "agent-session-9" });
    expect(Object.keys(sink.records[1]?.fields ?? {}).sort()).toEqual(
      [...common, "leaseId"].sort(),
    );
    expect(sink.records[1]?.fields).toMatchObject({ leaseId: "lse_4" });
    expect(JSON.stringify(sink.records)).not.toMatch(/iPhone 17|s3cret|60000/);

    // Refused before validation: a `leaseId` the input only claimed is not "from the validated
    // input", so the line omits it.
    await expect(
      runDispatch("lease.renew", { leaseId: "lse_raw", ttlMs: -1 }, session(), pipeline),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sink.records[2]?.fields).toMatchObject({
      operation: "lease.renew",
      code: "BAD_REQUEST",
    });
    expect(sink.records[2]?.fields).not.toHaveProperty("leaseId");
  });
});
