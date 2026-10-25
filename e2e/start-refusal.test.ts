import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

describe("an auto-started daemon that refuses to start (#760)", () => {
  it("simlock status prints DAEMON_STARTUP_FAILED with the daemon's start error, exit 1, in under 5 s", async () => {
    const env = await withDaemon({ mode: "auto" });
    const stateJson = join(env.home, "state.json");
    await writeFile(stateJson, "{}\n", "utf8");

    const startedAt = Date.now();
    const result = await env.cli(["status"]);
    const elapsedMs = Date.now() - startedAt;

    expect(result.code, result.stderr).toBe(1);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}") as {
      error: { code: string; message: string };
    };
    expect(failure.error.code).toBe("DAEMON_STARTUP_FAILED");
    expect(failure.error.message).toContain(`The daemon could not start: Found ${stateJson}, `);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe("a daemon start that cannot bind its HTTP port (#981)", () => {
  it("simlock daemon start prints DAEMON_STARTUP_FAILED naming EADDRINUSE and the port, exit 1, and never Daemon running", async () => {
    const holder = createServer();
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    // why: a slow startup read keeps the daemon converging after its bind fails, so its startup
    // status probe is answered (`starting`) before it stops itself.
    const slowRead = { latencyMs: { listManaged: 5_000 } } as const;
    try {
      const env = await withDaemon({
        mode: "auto",
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
        driverScript: { ios: slowRead, android: slowRead },
      });

      const result = await env.cli(["daemon", "start"]);

      await waitFor(
        async () =>
          (await readFile(env.logPath, "utf8").catch(() => "")).includes(
            '"HTTP frontend failed to start"',
          ),
        { label: "premise: the daemon logged its HTTP bind failure" },
      );
      expect(result.stdout).not.toContain("Daemon running");
      expect(result.stdout).not.toContain("Console:");
      expect(result.code, result.stdout).toBe(1);
      const failure = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}") as {
        error?: { code: string; message: string };
      };
      expect(failure.error?.code).toBe("DAEMON_STARTUP_FAILED");
      expect(failure.error?.message).toContain("EADDRINUSE");
      expect(failure.error?.message).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  }, 60_000);
});
