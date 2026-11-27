import { writeSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

import { expect } from "vitest";

interface BudgetOptions {
  /** why: `load` is the 1-minute load average, which covers the stretch the test just measured. */
  readonly host?: { readonly load: number; readonly cores: number };
  readonly log?: (line: string) => void;
}

/** why: past twice the bound a slow run fails whatever the load, so a real slowdown cannot hide behind a busy host for ever. */
const MAX_SCALE = 2;

/**
 * why: the one form a slow test bounds real time in (`test-lint.mjs` refuses the others). A host
 * with more runnable work than cores runs every step late, so the bound grows with load over
 * cores, up to `MAX_SCALE`; at or under one runnable task per core it is the bound as written.
 * The measured value goes to the lane log on a pass too, so a slowdown the scaling let through
 * still shows as a series. Windows reports no load average, so the bound never grows there.
 */
export function withinBudget(
  name: string,
  measuredMs: number,
  budgetMs: number,
  options: BudgetOptions = {},
): void {
  const host = options.host ?? { cores: availableParallelism(), load: loadavg()[0] ?? 0 };
  const scale = Math.min(MAX_SCALE, Math.max(1, host.load / host.cores));
  const allowedMs = Math.round(budgetMs * scale);
  const line = `SLOW BUDGET ${name}: ${String(measuredMs)} ms of ${String(allowedMs)} ms (${String(budgetMs)} ms x ${scale.toFixed(2)}, load ${host.load.toFixed(1)} on ${String(host.cores)} cores)`;
  (options.log ?? toLaneLog)(line);
  expect(measuredMs, line).toBeLessThanOrEqual(allowedMs);
}

function toLaneLog(line: string): void {
  writeSync(2, `${new Date().toISOString()} ${line}\n`);
}
