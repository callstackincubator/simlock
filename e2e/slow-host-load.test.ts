import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

interface StatusLoad {
  readonly cpu?: { readonly busyPercent: number };
  readonly memory?: { readonly totalBytes: number; readonly pressure?: string };
  readonly disk?: { readonly totalBytes: number };
}

describe.skipIf(process.platform !== "darwin")("host load on a Mac", { tags: ["slow"] }, () => {
  it(
    "a running worker's status --json load has memory total equal to sysctl hw.memsize, a pressure, a disk total equal to the data folder's statfs, and after 16 s a busy % from 0 to 100",
    { timeout: 90_000 },
    async () => {
      const env = await withDaemon();
      const { stdout } = await execFileAsync("sysctl", ["-n", "hw.memsize"]);
      const folder = await statfs(env.home);

      let load: StatusLoad | undefined;
      await waitFor(
        async () => {
          const result = await env.cli(["status", "--json"]);
          load = (result.json as { load?: StatusLoad }).load;
          return load?.cpu !== undefined;
        },
        { interval: 500, label: "load carries cpu", timeout: 40_000 },
      );

      expect(load?.memory?.totalBytes).toBe(Number(stdout.trim()));
      expect(["normal", "warn", "critical"]).toContain(load?.memory?.pressure);
      expect(load?.disk?.totalBytes).toBe(folder.blocks * folder.bsize);
      expect(load?.cpu?.busyPercent).toBeGreaterThanOrEqual(0);
      expect(load?.cpu?.busyPercent).toBeLessThanOrEqual(100);
    },
  );
});
