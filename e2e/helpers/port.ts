import { createServer } from "node:net";

/**
 * Binds an ephemeral loopback port and immediately releases it. Inherently racy -- nothing
 * stops another process taking it in between -- but it is the only way to pick a port no
 * other test env on this machine is already using, and the alternative (a fixed port) fails
 * every parallel run rather than an unlucky one.
 *
 * Its own module, free of any test runner, so the browser lane can use it too.
 */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    return port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
