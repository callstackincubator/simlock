import type { SeedSettler, SeedSettlerOptions } from "./types.js";

export function createSeedSettler(_options: SeedSettlerOptions): SeedSettler {
  return {
    beginStop: () => undefined,
    holdWhile: (work) => work(),
    settle: () => Promise.reject(new Error("not built")),
    start: () => undefined,
    stop: () => Promise.resolve(),
  };
}
