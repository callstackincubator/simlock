import { createServer, type AddressInfo, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { assertLanePortsFree } from "./ports.js";

const held: Server[] = [];

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function hold(port: number): Promise<void> {
  const server = createServer();
  held.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

describe("the real-proxy lane's port check", () => {
  it("passes with every port free", async () => {
    const ports = [await freePort(), await freePort()];

    await expect(assertLanePortsFree(ports)).resolves.toBeUndefined();
  });

  it("with a port held by the test, fails naming it", async () => {
    const port = await freePort();
    await hold(port);

    await expect(assertLanePortsFree([port])).rejects.toThrow(String(port));
  });
});
