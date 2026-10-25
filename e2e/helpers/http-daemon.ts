import { readFile } from "node:fs/promises";

import { withDaemon, type TestEnv, type WithDaemonOptions } from "./env.js";
import { freeLoopbackPort } from "./port.js";
import { waitFor } from "./wait.js";

const ATTEMPTS = 5;

// why: `freeLoopbackPort` releases the port it picked, so another process can take it before
// the daemon binds it. The daemon then fails its start with `EADDRINUSE` and `daemon start` exits
// non-zero (#981), so this starts a fresh env on a new port. It also waits for the daemon's own
// "HTTP gateway listening" line. `pickPort` lets this helper's own test hand it a taken port first.
export async function withHttpDaemon(
  options: (port: number) => WithDaemonOptions,
  pickPort: () => Promise<number> = freeLoopbackPort,
): Promise<{ readonly env: TestEnv; readonly port: number }> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const port = await pickPort();
    const env = await withDaemon({ ...options(port), mode: "auto" });
    const started = await env.startDaemon();
    if (started.code !== 0) {
      if ((await readLog(env)).includes("EADDRINUSE")) continue;
      throw new Error(`daemon start exited ${String(started.code)}: ${started.stderr}`);
    }
    let outcome: "listening" | "port-taken" | undefined;
    await waitFor(
      async () => {
        const log = await readLog(env);
        if (log.includes("EADDRINUSE")) outcome = "port-taken";
        else if (log.includes('"HTTP gateway listening"')) outcome = "listening";
        return outcome !== undefined;
      },
      { label: `the daemon's HTTP listener on port ${String(port)}` },
    );
    if (outcome === "listening") return { env, port };
  }
  throw new Error(
    `every one of ${String(ATTEMPTS)} free loopback ports was taken before the daemon bound it`,
  );
}

async function readLog(env: TestEnv): Promise<string> {
  try {
    return await readFile(env.logPath, "utf8");
  } catch {
    return "";
  }
}
