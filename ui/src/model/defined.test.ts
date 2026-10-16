import { describe, expect, it } from "vitest";

import { defined } from "./defined";

describe("defined", () => {
  it("keeps every field that has a value, falsy ones included, and leaves out the undefined", () => {
    const kept = defined({ a: 1, b: undefined, c: "", d: 0, e: null, f: false });

    expect(kept).toEqual({ a: 1, c: "", d: 0, e: null, f: false });
    expect("b" in kept).toBe(false);
  });
});
