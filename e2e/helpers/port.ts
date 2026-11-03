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

export interface HeldPort {
  readonly port: number;
  release(): Promise<void>;
}

// why: a test that needs a port taken, as another program on the machine would take it, holds one until `release`.
export async function holdLoopbackPort(): Promise<HeldPort> {
  const holder = createServer();
  const port = await new Promise<number>((resolve) => {
    holder.listen(0, "127.0.0.1", () => {
      const address = holder.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}
