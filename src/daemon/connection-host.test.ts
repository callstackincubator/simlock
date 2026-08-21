import { describe, expect, it } from "vitest";

import {
  FakeClock,
  IpcError,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryIpcTransport,
  MemoryLogSink,
  type IpcConnection,
  type IpcConnector,
  type IpcListenerFactory,
} from "../ports/index.js";
import { DaemonAlreadyRunningError, DaemonEndpointHost } from "./connection-host.js";

const endpoint = "/simlock/daemon.sock";

describe("DaemonEndpointHost", () => {
  it("binds a fresh endpoint and removes only its owned entry on repeated stop", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await filesystem.writeFileAtomic(endpoint, "owned");
    await filesystem.writeFileAtomic("/simlock/other.sock", "unrelated");
    await host.stop();
    await host.stop();
    expect(await filesystem.exists(endpoint)).toBe(false);
    expect(await filesystem.exists("/simlock/other.sock")).toBe(true);
    await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
  });

  it("removes a stale endpoint before binding", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "stale");
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await expect(ipc.connect(endpoint)).resolves.toBeDefined();
    await host.stop();
  });

  it("rejects a live endpoint before binding", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "live");
    const ipc = new MemoryIpcTransport();
    const existing = await ipc.listen(endpoint, () => undefined);
    const listenerFactory: IpcListenerFactory = {
      listen: async () => {
        throw new Error("listener must not bind after a live probe");
      },
    };
    await expect(
      hostFor(filesystem, ipc, listenerFactory).start(() => undefined),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    await existing.close();
  });

  it("maps bind races to an already-running error", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const racing: IpcListenerFactory = {
      listen: async () => {
        throw new IpcError("address-in-use", "race", undefined);
      },
    };
    await expect(hostFor(filesystem, ipc, racing).start(() => undefined)).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it("is one-shot after stopping", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await host.stop();
    await expect(host.start(() => undefined)).rejects.toThrow("already been started");
  });

  it("propagates unknown probe failures", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "existing");
    const connector: IpcConnector = {
      connect: async (): Promise<IpcConnection> => {
        throw new IpcError("unknown", "denied", undefined);
      },
    };
    const ipc = new MemoryIpcTransport();
    await expect(hostFor(filesystem, connector, ipc).start(() => undefined)).rejects.toThrow(
      "denied",
    );
  });

  it("logs claiming a fresh endpoint", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    const host = new DaemonEndpointHost({
      connector: ipc,
      endpoint,
      filesystem,
      listenerFactory: ipc,
      logger,
    });

    await host.start(() => undefined);

    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "Claimed daemon socket",
        fields: { endpoint },
      }),
    );
    await host.stop();
  });

  it("logs recovering a stale endpoint before claiming it", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(endpoint, "stale");
    const ipc = new MemoryIpcTransport();
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "debug", sink });
    const host = new DaemonEndpointHost({
      connector: ipc,
      endpoint,
      filesystem,
      listenerFactory: ipc,
      logger,
    });

    await host.start(() => undefined);

    expect(sink.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "Recovered stale daemon socket" }),
    );
    const claimedIndex = sink.records.findIndex(
      (record) => record.message === "Claimed daemon socket",
    );
    const recoveredIndex = sink.records.findIndex(
      (record) => record.message === "Recovered stale daemon socket",
    );
    expect(recoveredIndex).toBeLessThan(claimedIndex);
    await host.stop();
  });
});

function hostFor(
  filesystem: MemoryFilesystem,
  connector: IpcConnector,
  listenerFactory: IpcListenerFactory,
): DaemonEndpointHost {
  return new DaemonEndpointHost({ connector, endpoint, filesystem, listenerFactory });
}
