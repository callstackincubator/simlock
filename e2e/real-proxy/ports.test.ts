import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { assertLanePortsFree } from "./ports.js";

const held: Server[] = [];

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

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
    await expect(assertLanePortsFree()).resolves.toBeUndefined();
  });

  it("with port 4180 held by the test, fails naming 4180", async () => {
    await hold(4180);

    await expect(assertLanePortsFree()).rejects.toThrow("4180");
  });
});
