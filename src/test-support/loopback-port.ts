import { createServer } from "node:net";

const ATTEMPTS = 5;

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

function portWasTaken(error: unknown): boolean {
  if ((error as { readonly code?: unknown } | null)?.code === "EADDRINUSE") return true;
  // why: a daemon's start rethrows the bind failure as its own error, so only the message names it.
  return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message);
}

// why: `freeLoopbackPort` releases the port it picked, so a process of a parallel lane can take it
// before the daemon binds it; the start then rejects with EADDRINUSE and this tries a new port.
export async function startOnFreePort<T>(
  start: (port: number) => Promise<T>,
): Promise<{ readonly port: number; readonly started: T }> {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freeLoopbackPort();
    try {
      return { port, started: await start(port) };
    } catch (error) {
      if (!portWasTaken(error) || attempt === ATTEMPTS) throw error;
    }
  }
}
