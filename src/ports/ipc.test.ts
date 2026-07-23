import { describe, expect, it } from "vitest";

import { MemoryIpcTransport } from "./ipc.js";

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
