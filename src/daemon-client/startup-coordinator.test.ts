import { describe, expect, it, vi } from "vitest";

import { FakeClock, FakeDaemonLauncher, IpcError } from "../ports/index.js";
import type { DaemonConnector } from "./connector.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonStartupCoordinator } from "./startup-coordinator.js";

describe("DaemonStartupCoordinator", () => {
  it("returns an existing connection without launching", async () => {
    const connection = stubConnection();
    const launcher = new FakeDaemonLauncher();
    const coordinator = new DaemonStartupCoordinator({
      clock: new FakeClock(),
      connector: { connect: async () => connection },
      launcher,
    });
    await expect(coordinator.connect()).resolves.toBe(connection);
    expect(launcher.launches).toBe(0);
  });

  it("launches once after an unavailable endpoint", async () => {
    const connection = stubConnection();
    let attempts = 0;
    const connector: DaemonConnector = {
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new IpcError("endpoint-not-found", "missing", undefined);
        return connection;
      },
    };
    const launcher = new FakeDaemonLauncher();
    const coordinator = new DaemonStartupCoordinator({
      clock: new FakeClock(),
      connector,
      launcher,
    });
    await expect(coordinator.connect()).resolves.toBe(connection);
    expect(launcher.launches).toBe(1);
  });

  it("propagates unexpected connection errors without launching", async () => {
    const launcher = new FakeDaemonLauncher();
    const coordinator = new DaemonStartupCoordinator({
      clock: new FakeClock(),
      connector: {
        connect: async () => {
          throw new IpcError("unknown", "boom", undefined);
        },
      },
      launcher,
    });
    await expect(coordinator.connect()).rejects.toThrow("boom");
    expect(launcher.launches).toBe(0);
  });

  it("retries once after launch and times out with the last transport error", async () => {
    const clock = new FakeClock();
    const launcher = new FakeDaemonLauncher();
    const coordinator = new DaemonStartupCoordinator({
      clock,
      connector: {
        connect: async () => {
          throw new IpcError("connection-refused", "still booting", undefined);
        },
      },
      launcher,
      retryIntervalMs: 50,
      startupTimeoutMs: 50,
    });
    const pending = coordinator.connect();
    await vi.waitFor(() => expect(clock.pendingTimerCount).toBe(1));
    clock.advance(50);
    await expect(pending).rejects.toThrow("still booting");
    expect(launcher.launches).toBe(1);
  });

  it("propagates launcher failures without retrying", async () => {
    const coordinator = new DaemonStartupCoordinator({
      clock: new FakeClock(),
      connector: {
        connect: async () => {
          throw new IpcError("endpoint-not-found", "missing", undefined);
        },
      },
      launcher: new FakeDaemonLauncher(() => {
        throw new Error("launch failed");
      }),
    });
    await expect(coordinator.connect()).rejects.toThrow("launch failed");
  });
});

function stubConnection(): DaemonConnection {
  return {
    close: async () => undefined,
    onPush: () => () => undefined,
    request: async () => undefined,
  };
}
