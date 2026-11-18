import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { FseventsdModuleConfig } from "./definition.js";

const LIMIT_BYTES = 2 * 1024 ** 3;
const UNITS: Readonly<Record<string, number>> = {
  G: 1024 ** 3,
  K: 1024,
  M: 1024 ** 2,
  T: 1024 ** 4,
};

// why: `top` prints a figure like `28G`, `2049M` or `2100M+`, the `+` meaning it rose since the last sample.
function bytesOf(figure: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KMGT])[+-]?$/.exec(figure.trim());
  const unit = UNITS[match?.[2] ?? ""];
  return match?.[1] === undefined || unit === undefined ? undefined : Number(match[1]) * unit;
}

// why: a reading that fails must not look like fseventsd being absent, so it logs.
type Reading = { readonly bytes: number } | { readonly absent: true } | { readonly failed: string };

const READ_TIMEOUT_MS = 10_000;

export function createWorker(ctx: WorkerContext<FseventsdModuleConfig>): WorkerModule {
  const read = async (): Promise<Reading> => {
    const found = await ctx.processRunner.run("pgrep", ["-x", "fseventsd"], {
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (found.code === 1) return { absent: true };
    const pid = found.stdout.trim();
    if (found.code !== 0 || pid === "") return { failed: "pgrep did not name fseventsd" };
    const top = await ctx.processRunner.run("top", ["-l", "1", "-pid", pid, "-stats", "mem"], {
      timeoutMs: READ_TIMEOUT_MS,
    });
    const bytes = top.code === 0 ? bytesOf(top.stdout.trim().split("\n").at(-1) ?? "") : undefined;
    return bytes === undefined ? { failed: "top gave no memory figure" } : { bytes };
  };
  if (ctx.hostPlatform !== "darwin") {
    const reason = "fseventsd exists only on macOS";
    return {
      capability: { name: ctx.name, read: () => Promise.resolve({ reason, state: "unavailable" }) },
      findings: () => [
        {
          message: "capabilities.fseventsd.enabled is true, but this host is not macOS.",
          remedy: "Set capabilities.fseventsd.enabled to false.",
        },
      ],
    };
  }
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    findings: async () => {
      const reading = await read().catch((error: unknown) => ({
        failed: error instanceof Error ? error.message : String(error),
      }));
      if ("failed" in reading) {
        ctx.logger.warn("Could not read fseventsd's memory", { reason: reading.failed });
        return [];
      }
      if ("absent" in reading || reading.bytes <= LIMIT_BYTES) return [];
      return [
        {
          advisory: true,
          message: `fseventsd uses ${(reading.bytes / 1024 ** 3).toFixed(1)} GB of memory, over the 2 GB limit`,
          remedy: "Restart it with `sudo killall fseventsd`; macOS starts it again.",
        },
      ];
    },
  };
}
