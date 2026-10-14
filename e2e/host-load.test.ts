import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

interface StatusLoad {
  readonly ageMs: number;
  readonly cpu?: { readonly busyPercent: number; readonly cores: number };
  readonly memory?: { readonly totalBytes: number; readonly pressure?: string };
  readonly disk?: { readonly freeBytes: number; readonly totalBytes: number };
}

describe.skipIf(process.platform === "darwin")("host load on a worker", () => {
  it(
    "a spawned worker's simlock status prints a Load line with no pressure part, and its status --json load has memory without pressure, disk, and CPU after 16 s",
    { timeout: 60_000 },
    async () => {
      const env = await withDaemon();

      const human = await env.cli(["status"]);
      expect(human.code, human.stderr).toBe(0);
      const loadLine = human.stdout.split("\n").find((line) => line.startsWith("Load: "));
      expect(loadLine, human.stdout).toBeDefined();
      expect(loadLine).toContain("memory ");
      expect(loadLine).toContain("disk ");
      expect(loadLine).not.toContain("pressure");

      let load: StatusLoad | undefined;
      await waitFor(
        async () => {
          const result = await env.cli(["status", "--json"]);
          load = (result.json as { load?: StatusLoad }).load;
          return load?.cpu !== undefined;
        },
        { interval: 500, label: "load carries cpu", timeout: 40_000 },
      );

      expect(load).toEqual(
        expect.objectContaining({
          cpu: expect.anything(),
          disk: expect.anything(),
          memory: expect.anything(),
        }),
      );
      const { cpu, disk, memory } = load as Required<StatusLoad>;
      expect(cpu.busyPercent).toBeGreaterThanOrEqual(0);
      expect(cpu.busyPercent).toBeLessThanOrEqual(100);
      expect(cpu.cores).toBeGreaterThan(0);
      expect(memory.totalBytes).toBeGreaterThan(0);
      expect(memory).not.toHaveProperty("pressure");
      expect(disk.totalBytes).toBeGreaterThanOrEqual(disk.freeBytes);
      expect(disk.totalBytes).toBeGreaterThan(0);
    },
  );
});
