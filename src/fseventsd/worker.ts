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

export function createWorker(ctx: WorkerContext<FseventsdModuleConfig>): WorkerModule {
  const read = async (): Promise<number | undefined> => {
    const found = await ctx.processRunner.run("pgrep", ["-x", "fseventsd"]);
    const pid = found.stdout.trim();
    if (found.code !== 0 || pid === "") return undefined;
    const top = await ctx.processRunner.run("top", ["-l", "1", "-pid", pid, "-stats", "mem"]);
    return bytesOf(top.stdout.trim().split("\n").at(-1) ?? "");
  };
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    findings: async () => {
      const bytes = await read();
      if (bytes === undefined || bytes <= LIMIT_BYTES) return [];
      return [
        {
          advisory: true,
          message: `fseventsd uses ${(bytes / 1024 ** 3).toFixed(1)} GB of memory, over the 2 GB limit`,
          remedy: "Restart it with `sudo killall fseventsd`; macOS starts it again.",
        },
      ];
    },
  };
}
