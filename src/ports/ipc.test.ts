import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryIpcTransport, NodeIpcTransport } from "./ipc.js";

const implementations = [
  { name: "memory transport", create: () => new MemoryIpcTransport() },
  { name: "node transport", create: () => new NodeIpcTransport() },
];

describe.each(implementations)("IpcTransport contract: $name", ({ create }) => {
  let directory: string;
  let endpoint: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "simlock-ipc-"));
    endpoint = join(directory, "daemon.sock");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("delivers what a client writes to the server, and the client's close", async () => {
    const ipc = create();
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    const listener = await ipc.listen(endpoint, (connection) => {
      server = connection;
    });
    try {
      const client = await ipc.connect(endpoint);
      await expect.poll(() => server).toBeDefined();
      const received: string[] = [];
      server?.onData((chunk) => received.push(chunk));

      await client.write("hello");
      await expect.poll(() => received).toEqual(["hello"]);

      await client.close();
      await expect.poll(() => server?.closed).toBe(true);
    } finally {
      await listener.close();
    }
  });

  it("closes a connection whose data was never read, even after the client wrote to it", async () => {
    const ipc = create();
    let server: Awaited<ReturnType<typeof ipc.connect>> | undefined;
    const listener = await ipc.listen(endpoint, (connection) => {
      server = connection;
    });
    const client = await ipc.connect(endpoint);
    client.onData(() => undefined);
    await client.write("unread\n");
    await expect.poll(() => server).toBeDefined();

    await Promise.race([
      server?.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 2000)),
    ]);
    await Promise.race([
      listener.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("listener close hung")), 2000)),
    ]);
  });

  it("reports an endpoint nothing listens on as endpoint-not-found", async () => {
    await expect(create().connect(endpoint)).rejects.toMatchObject({
      code: "endpoint-not-found",
    });
  });

  it("refuses a second listener on one endpoint as address-in-use", async () => {
    const ipc = create();
    const listener = await ipc.listen(endpoint, () => undefined);
    try {
      await expect(ipc.listen(endpoint, () => undefined)).rejects.toMatchObject({
        code: "address-in-use",
      });
    } finally {
      await listener.close();
    }
  });

  it("refuses new connections once its listener closes", async () => {
    const ipc = create();
    const listener = await ipc.listen(endpoint, () => undefined);
    await listener.close();

    await expect(ipc.connect(endpoint)).rejects.toMatchObject({ code: "endpoint-not-found" });
  });
});
