import { describe, expect, it } from "vitest";

import {
  IpcError,
  MemoryFilesystem,
  MemoryIpcTransport,
  type IpcConnection,
  type IpcConnector,
  type IpcListenerFactory,
} from "../ports/index.js";
import { DaemonAlreadyRunningError, DaemonEndpointHost } from "./connection-host.js";

const endpoint = "/pitlane/daemon.sock";

describe("DaemonEndpointHost", () => {
  it("binds a fresh endpoint and removes only its owned entry on repeated stop", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    expect(await filesystem.exists(endpoint)).toBe(false);
    await host.stop();
    await host.stop();
    await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
  });

  it("removes a stale endpoint before binding", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/pitlane");
    await filesystem.writeFileAtomic(endpoint, "stale");
    const ipc = new MemoryIpcTransport();
    const host = hostFor(filesystem, ipc, ipc);
    await host.start(() => undefined);
    await expect(ipc.connect(endpoint)).resolves.toBeDefined();
    await host.stop();
  });

  it("rejects a live endpoint and maps bind races", async () => {
    const filesystem = new MemoryFilesystem();
    const ipc = new MemoryIpcTransport();
    const existing = await ipc.listen(endpoint, () => undefined);
    await expect(hostFor(filesystem, ipc, ipc).start(() => undefined)).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
    await existing.close();
    const racing: IpcListenerFactory = {
      listen: async () => {
        throw new IpcError("address-in-use", "race", undefined);
      },
    };
    await expect(hostFor(filesystem, ipc, racing).start(() => undefined)).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it("propagates unknown probe failures", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/pitlane");
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
});

function hostFor(
  filesystem: MemoryFilesystem,
  connector: IpcConnector,
  listenerFactory: IpcListenerFactory,
): DaemonEndpointHost {
  return new DaemonEndpointHost({ connector, endpoint, filesystem, listenerFactory });
}
