import { createServer } from "node:net";

import { expect, startDaemon, test } from "./fixtures.js";

/**
 * why: reproduces #673. A failed daemon start reports only what the CLI guessed at while it polled
 * for a socket (`Timed out starting simlock daemon: connect ENOENT <home>/daemon.sock`, or
 * `Daemon connection closed` once the daemon answered and then tore itself down), never the reason
 * it wrote to `daemon.log` -- and `startDaemon`'s catch deletes that log with the rest of the home,
 * so the cause cannot be read afterwards either. The conflict below is the EADDRINUSE family of
 * #553, staged by holding the HTTP port the daemon is about to bind.
 */

function reported(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined
    ? error.message
    : `${error.message}\ncause: ${String(error.cause)}`;
}

async function hold(port: number): Promise<() => Promise<void>> {
  const holder = createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once("error", (error: Error) =>
      reject(new Error(`premise: could not hold port ${String(port)}: ${error.message}`)),
    );
    holder.listen(port, "127.0.0.1", () => resolve());
  });
  return () => new Promise<void>((resolve) => holder.close(() => resolve()));
}

test("a daemon start that cannot bind its HTTP port reports the port conflict", async () => {
  const daemon = await startDaemon("worker");
  try {
    // why: restarting on its own home and port first shows that same start is accepted, so the
    // refused one below can only be about the port this test comes to hold.
    await daemon.stop();
    await daemon.start();

    await daemon.stop();
    const release = await hold(daemon.port);
    let failure: unknown;
    let started = false;
    try {
      await daemon.start();
      started = true;
    } catch (error: unknown) {
      failure = error;
    } finally {
      await release();
    }

    if (started) {
      throw new Error(
        `premise: the daemon bound port ${String(daemon.port)}, which this test holds`,
      );
    }
    expect(reported(failure)).toContain("EADDRINUSE");
    expect(reported(failure)).toContain(String(daemon.port));
  } finally {
    await daemon.dispose();
  }
});
