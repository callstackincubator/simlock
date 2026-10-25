import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

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
