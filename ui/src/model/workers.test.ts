import { describe, expect, it } from "vitest";

import { warmPoolRows, type WarmTarget } from "./workers";

const REFUSED: WarmTarget = {
  booting: 0,
  count: 1,
  mode: "full",
  model: "iPhone 17",
  origin: "configured",
  osVersion: "27.0",
  platform: "ios",
  ready: 0,
  short: "runtime-missing",
};

describe("the warm pool table's row identities", () => {
  it("keeps the identity of a row when a row of another kind comes or goes", () => {
    const other: WarmTarget = { ...REFUSED, model: "iPhone 16" };

    const alone = warmPoolRows([REFUSED]);
    const beside = warmPoolRows([other, REFUSED]);

    expect(alone.map((row) => row.key)).toEqual(["ios-iPhone 17-27.0-full#0"]);
    expect(beside.map((row) => row.key)).toEqual([
      "ios-iPhone 16-27.0-full#0",
      "ios-iPhone 17-27.0-full#0",
    ]);
  });
});
