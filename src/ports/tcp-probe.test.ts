import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FakeTcpProbe, NodeTcpProbe } from "./index.js";

let server: Server | undefined;

/** Listens on an ephemeral loopback port and reports which one it got. */
async function listen(): Promise<number> {
  server = createServer();

  return new Promise<number>((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

async function close(): Promise<void> {
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => {
    if (closing === undefined) {
      resolve();
      return;
    }

    closing.close(() => resolve());
  });
}

afterEach(close);

describe("NodeTcpProbe", () => {
  it("reports a port something is listening on as taken", async () => {
    const port = await listen();

    await expect(new NodeTcpProbe().isListening(port)).resolves.toBe(true);
  });

  it("reports a port nothing answers on as free", async () => {
    const port = await listen();
    await close();

    await expect(new NodeTcpProbe().isListening(port)).resolves.toBe(false);
  });

  it.each([-1, 0.5, 70_000])(
    "reports a port nothing could listen on as free (%s)",
    async (port) => {
      // `createConnection` throws for these before a socket exists at all, and a probe that
      // rejects instead of answering turns a misconfigured port into a daemon that cannot
      // even report why it will not start.
      await expect(new NodeTcpProbe().isListening(port)).resolves.toBe(false);
    },
  );
});

describe("FakeTcpProbe", () => {
  it("answers with the ports a test declared, as they come and go", async () => {
    const probe = new FakeTcpProbe([5038]);

    await expect(probe.isListening(5038)).resolves.toBe(true);
    await expect(probe.isListening(5039)).resolves.toBe(false);

    probe.stopListening(5038);
    probe.startListening(5039);

    await expect(probe.isListening(5038)).resolves.toBe(false);
    await expect(probe.isListening(5039)).resolves.toBe(true);
  });
});
