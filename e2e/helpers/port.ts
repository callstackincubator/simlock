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
// The holder destroys every connection at once: `server.close` waits for open connections, and a
// client keeping one alive (a port scanner, a probe) would otherwise stall the release forever.
// `wanted` pins a specific port and rejects when it is taken; 0 picks a free one.
export async function holdLoopbackPort(wanted = 0): Promise<HeldPort> {
  const holder = createServer((socket) => socket.destroy());
  const port = await new Promise<number>((resolve, reject) => {
    holder.once("error", (error: Error) =>
      reject(new Error(`could not hold port ${String(wanted)}: ${error.message}`)),
    );
    holder.listen(wanted, "127.0.0.1", () => {
      const address = holder.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}
