import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { withDaemon } from "./index.js";

// why: #1891. A worker reads this host's real memory (ADR 0068); at `warming-paused` its warm pool
// starts nothing, so a test that waits for a warm spare times out on a loaded host. The config the
// helper seeds is the one place a test daemon can be kept off the host's memory. `mode: "auto"`
// seeds the config and starts no daemon, so the real case boots nothing.
describe("e2e test daemons and the host's memory", () => {
  it.each(["fake", "real"] as const)(
    "a worker the e2e helpers seed for the %s driver has memory pressure turned off",
    async (driver) => {
      const env = await withDaemon({ driver, mode: "auto" });
      const seeded = JSON.parse(await readFile(env.configPath, "utf8")) as {
        memoryPressure?: { enabled?: boolean };
      };
      expect(seeded.memoryPressure?.enabled, "memoryPressure.enabled in the seeded config").toBe(
        false,
      );
    },
  );
});
