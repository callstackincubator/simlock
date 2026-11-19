import { createServer } from "node:net";

// why: the browser lane imports this module, so it re-exports the one helper of src/test-support
// that holds no test runner, instead of keeping a second copy of the picker.
export { freeLoopbackPort, startOnFreePort } from "../../src/test-support/loopback-port.js";

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
