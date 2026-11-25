import { describe, expect, it } from "vitest";

import { errorMessage } from "./index.js";

describe("errorMessage", () => {
  it("returns an Error's message, and the text of anything else", () => {
    class TaggedError extends Error {
      constructor(
        message: string,
        readonly code: string,
      ) {
        super(message);
      }
    }
    const cases: readonly [unknown, string][] = [
      [new Error("boom"), "boom"],
      [new TaggedError("no capacity", "NO_CAPACITY"), "no capacity"],
      ["plain text", "plain text"],
      [42, "42"],
      [undefined, "undefined"],
    ];
    expect(cases.map(([value]) => errorMessage(value))).toEqual(cases.map(([, text]) => text));
  });
});
