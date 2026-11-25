import type { WorkerContext, WorkerModule } from "../modules/index.js";
import type { FseventsdModuleConfig } from "./definition.js";
import { errorMessage } from "../shared/index.js";

const LIMIT_BYTES = 2 * 1024 ** 3;
const UNITS: Readonly<Record<string, number>> = {
  B: 1,
  G: 1024 ** 3,
  K: 1024,
  M: 1024 ** 2,
  T: 1024 ** 4,
};

// why: `top` prints a figure like `28G`, `2049M` or `2100M+`, the `+` meaning it rose since the last sample.
function bytesOf(figure: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([BKMGT])[+-]?$/.exec(figure);
  const unit = UNITS[match?.[2] ?? ""];
  return match?.[1] === undefined || unit === undefined ? undefined : Number(match[1]) * unit;
}

// why: the module may not import the CLI's `escapeControl`, and the output it quotes in a log line comes from a process.
function unexpected(line: string): string {
  const shown = line
    .slice(0, 80)
    .replace(/\p{Cc}/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `unexpected output "${shown}"`;
}

// why: a reading that fails must not look like fseventsd being absent, so it logs.
type Reading = { readonly bytes: number } | { readonly absent: true } | { readonly failed: string };

const READ_TIMEOUT_MS = 5_000;

type Run = WorkerContext<FseventsdModuleConfig>["processRunner"]["run"];
type Step = { readonly ok: string } | { readonly failed: string } | { readonly absent: true };

// why: a command that ends badly names itself in the reason; exit 1 of `pgrep` alone means "not running".
async function step(run: Run, command: string, args: readonly string[]): Promise<Step> {
  const name = command.split("/").at(-1) ?? command;
  const result = await run(command, args, { timeoutMs: READ_TIMEOUT_MS });
  if (result.endedBy === "timeout") return { failed: `${name} timed out after 5 s` };
  if (name === "pgrep" && result.code === 1) return { absent: true };
  if (result.code !== 0) return { failed: `${name} exited ${String(result.code)}` };
  return { ok: result.stdout };
}

export function createWorker(ctx: WorkerContext<FseventsdModuleConfig>): WorkerModule {
  const read = async (): Promise<Reading> => {
    const run: Run = (command, args, options) => ctx.processRunner.run(command, args, options);
    const found = await step(run, "/usr/bin/pgrep", ["-x", "fseventsd"]);
    if (!("ok" in found)) return found;
    const pid = found.ok.split("\n")[0]?.trim() ?? "";
    if (!/^\d+$/.test(pid)) return { failed: unexpected(pid) };
    const top = await step(run, "/usr/bin/top", ["-l", "1", "-pid", pid, "-stats", "mem"]);
    if (!("ok" in top)) return top;
    const lines = top.ok.split("\n").map((line) => line.trim());
    const last = lines.filter((line) => line !== "").at(-1) ?? "";
    const bytes = bytesOf(last);
    return bytes === undefined ? { failed: unexpected(last) } : { bytes };
  };
  if (ctx.hostPlatform !== "darwin") {
    const reason = "fseventsd exists only on macOS";
    return {
      capability: { name: ctx.name, read: () => Promise.resolve({ reason, state: "unavailable" }) },
      findings: () => [
        {
          message: reason,
          remedy: "Set capabilities.fseventsd.enabled to false.",
        },
      ],
    };
  }
  return {
    capability: { name: ctx.name, read: () => Promise.resolve({ state: "available" }) },
    findings: async () => {
      const reading = await read().catch((error: unknown) => ({
        failed: errorMessage(error),
      }));
      if ("failed" in reading) {
        ctx.logger.warn(`Could not read fseventsd's memory: ${reading.failed}`);
        return [];
      }
      if ("absent" in reading || reading.bytes <= LIMIT_BYTES) return [];
      return [
        {
          advisory: true,
          message: `fseventsd uses ${(reading.bytes / 1024 ** 3).toFixed(1)} GB of memory, over the 2 GB limit. macOS keeps file-change records there, and lease churn can grow it until the Mac swaps.`,
          remedy:
            'Restart it with `sudo killall fseventsd` (macOS starts it again at once). To restart it every hour, see "fseventsd uses too much memory" in the worker troubleshooting docs.',
        },
      ];
    },
  };
}
