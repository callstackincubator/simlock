import { afterEach, describe, expect, it, vi } from "vitest";

import { filterSqliteExperimentalWarning } from "./sqlite.js";

const original = process.emitWarning;

afterEach(() => {
  process.emitWarning = original;
});

describe("filterSqliteExperimentalWarning", () => {
  it("drops the SQLite ExperimentalWarning and passes every other warning on to Node", () => {
    const passed = vi.fn();
    process.emitWarning = passed as unknown as typeof process.emitWarning;
    filterSqliteExperimentalWarning();

    process.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
    process.emitWarning("Another experimental feature", "ExperimentalWarning");
    process.emitWarning("SQLite is an experimental feature and might change at any time");
    process.emitWarning("simlock-other-warning");

    expect(passed.mock.calls.map(([message]) => message)).toEqual([
      "Another experimental feature",
      "SQLite is an experimental feature and might change at any time",
      "simlock-other-warning",
    ]);
  });
});
