import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { FakeTcpProbe, NodeTcpProbe } from "./index.js";

let server: Server | undefined;
const accepted = new Set<Socket>();

/** Listens on an ephemeral loopback port and reports which one it got. */
async function listen(): Promise<number> {
  server = createServer();
  server.on("connection", (socket) => accepted.add(socket));

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

    // `close` alone only stops accepting: a connection a probe opened and then abandoned
    // keeps it pending, and the `send` tests deliberately leave one lying around.
    for (const socket of accepted) socket.destroy();
    accepted.clear();
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

describe("NodeTcpProbe.send", () => {
  it("delivers the payload and resolves with everything the peer said before closing", async () => {
    const received: string[] = [];
    const port = await listen();
    server?.on("connection", (socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received.push(chunk);
        socket.end("OKAY");
      });
    });

    await expect(new NodeTcpProbe().send(port, "0012host:emulator:5587")).resolves.toBe("OKAY");
    expect(received).toEqual(["0012host:emulator:5587"]);
  });

  it("resolves empty when the peer answers nothing before the timeout", async () => {
    const port = await listen();

    // The one service this carries is answered by silence, so a timeout completes the call
    // rather than failing it.
    await expect(new NodeTcpProbe().send(port, "ping", 50)).resolves.toBe("");
  });

  it("rejects when there was no peer to send to", async () => {
    const port = await listen();
    await close();

    // A refused connection must not read like a server that answered nothing: the caller
    // decides what to do about a failed registration, and cannot if both look identical.
    await expect(new NodeTcpProbe().send(port, "ping", 50)).rejects.toThrow();
  });
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

  it("records what was sent and answers with what the test scripted", async () => {
    const probe = new FakeTcpProbe();
    probe.replyWith("OKAY");

    await expect(probe.send(5038, "0012host:emulator:5587")).resolves.toBe("OKAY");
    expect(probe.sends).toEqual([{ payload: "0012host:emulator:5587", port: 5038 }]);
  });
});
