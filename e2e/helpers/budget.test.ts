import { describe, expect, it } from "vitest";

import { withinBudget } from "./index.js";

const quiet = { log: () => undefined };
const at = (load: number, cores = 12) => ({ ...quiet, host: { cores, load } });

describe("withinBudget", () => {
  it("keeps the bound as written while the load is at most one per core: 5500 ms of 5500 passes and 5528 ms fails, at load 0 and at load 12 on 12 cores", () => {
    for (const load of [0, 12]) {
      withinBudget("key frame gap", 5_500, 5_500, at(load));
      expect(() => {
        withinBudget("key frame gap", 5_528, 5_500, at(load));
      }).toThrow(/key frame gap: 5528 ms of 5500 ms \(5500 ms x 1\.00/);
    }
  });

  it("grows the bound by load over cores: at load 18 on 12 cores 5500 ms allows 8250 ms and refuses 8251 ms", () => {
    withinBudget("key frame gap", 8_250, 5_500, at(18));
    expect(() => {
      withinBudget("key frame gap", 8_251, 5_500, at(18));
    }).toThrow(/8251 ms of 8250 ms \(5500 ms x 1\.50, load 18\.0 on 12 cores\)/);
  });

  it("never grows the bound past twice: at load 125 on 12 cores 3000 ms allows 6000 ms and refuses 6001 ms", () => {
    withinBudget("fold switch", 6_000, 3_000, at(125));
    expect(() => {
      withinBudget("fold switch", 6_001, 3_000, at(125));
    }).toThrow(/6001 ms of 6000 ms \(3000 ms x 2\.00/);
  });

  it("logs the measured value, the bound and the load on a pass", () => {
    const lines: string[] = [];

    withinBudget("fold switch", 3_860, 3_000, {
      host: { cores: 12, load: 125.3 },
      log: (line) => lines.push(line),
    });

    expect(lines).toEqual([
      "SLOW BUDGET fold switch: 3860 ms of 6000 ms (3000 ms x 2.00, load 125.3 on 12 cores)",
    ]);
  });

  it("reads this host's load when given none: a value under the bound passes and one over twice the bound fails", () => {
    withinBudget("this host", 999, 1_000, quiet);
    expect(() => {
      withinBudget("this host", 2_001, 1_000, quiet);
    }).toThrow(/this host: 2001 ms of \d+ ms/);
  });
});
