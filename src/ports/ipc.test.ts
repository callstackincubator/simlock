import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryIpcTransport, NodeIpcTransport } from "./ipc.js";

describe("MemoryIpcTransport", () => {
  it("delivers bidirectional data and closure", async () => {
    const ipc = new MemoryIpcTransport();
    let serverConnection: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    await ipc.listen("/daemon.sock", (connection) => {
      serverConnection = connection;
    });
    const client = await ipc.connect("/daemon.sock");
    const received: string[] = [];
    serverConnection?.onData((chunk) => received.push(chunk));
    await client.write("hello");
    expect(received).toEqual(["hello"]);
    await client.close();
    expect(serverConnection?.closed).toBe(true);
  });

  it("normalizes missing endpoints and duplicate listeners", async () => {
    const ipc = new MemoryIpcTransport();
    await expect(ipc.connect("/missing")).rejects.toMatchObject({
      code: "endpoint-not-found",
    });
    await ipc.listen("/daemon.sock", () => undefined);
    await expect(ipc.listen("/daemon.sock", () => undefined)).rejects.toMatchObject({
      code: "address-in-use",
    });
  });
});

describe("NodeIpcTransport", () => {
  it("connects, exchanges data, closes, and normalizes setup failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pitlane-ipc-"));
    const endpoint = join(directory, "daemon.sock");
    const ipc = new NodeIpcTransport();
    try {
      await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
      let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
      const listener = await ipc.listen(endpoint, (connection) => {
        server = connection;
      });
      await expect(ipc.listen(endpoint, () => undefined)).rejects.toMatchObject({
        code: "address-in-use",
      });
      const client = await ipc.connect(endpoint);
      await expect.poll(() => server).toBeDefined();
      const received: string[] = [];
      server?.onData((chunk) => received.push(chunk));
      await client.write("ping");
      await expect.poll(() => received).toEqual(["ping"]);
      await client.close();
      await listener.close();
      await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
