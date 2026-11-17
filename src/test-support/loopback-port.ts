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

// why: a daemon that lost its HTTP port stops itself, but its `start` settles only once that stop does,
// and a stop held by a hung hook or a hung boot never ends; the "HTTP frontend failed to start" line the
// daemon logs first is the signal that works in both cases.
export async function portLostIn(
  sink: { readonly records: readonly { readonly message: string }[] },
  signal: AbortSignal,
): Promise<never> {
  while (!signal.aborted) {
    if (sink.records.some((record) => record.message === "HTTP frontend failed to start")) {
      throw Object.assign(new Error("address already in use"), { code: "EADDRINUSE" });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return new Promise<never>(() => undefined);
}

// why: for a start that can stay pending after it lost its port; it rejects as soon as the daemon logs the loss.
export async function startUnlessPortLost<T>(
  sink: Parameters<typeof portLostIn>[0],
  start: Promise<T>,
): Promise<T> {
  const watch = new AbortController();
  void start.catch(() => undefined);
  try {
    return await Promise.race([start, portLostIn(sink, watch.signal)]);
  } finally {
    watch.abort();
  }
}
