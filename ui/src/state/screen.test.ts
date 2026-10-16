import { describe, expect, it } from "vitest";

import { ApiError } from "../data/api";
import { refusalOf } from "./screen";

describe("what a refused stream says", () => {
  it("says which devices can be streamed when the daemon answers that this one cannot", () => {
    const refused = new ApiError(
      415,
      undefined,
      "A physical iPhone's screen cannot be streamed; only a simulator's can",
    );

    expect(refusalOf(refused)).toBe(
      "This device cannot be streamed. A live screen is captured from a simulator or an emulator, not from a physical phone.",
    );
  });

  it("keeps the daemon's own reason when it named one, and says what else to check", () => {
    const refused = new ApiError(404, undefined, "Unknown lease: lse_1");

    expect(refusalOf(refused)).toBe(
      "Unknown lease: lse_1 A stream is only offered where capabilities.stream.enabled is on, and only for a lease that is still held.",
    );
  });

  it("keeps a capture program's own words when the worker could not run one", () => {
    const refused = new ApiError(
      500,
      undefined,
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );

    expect(refusalOf(refused)).toBe(
      "The screen capture produced no stream (the capture tool exited with code 1)",
    );
  });

  it("keeps the daemon's words for a refusal this console has no advice about", () => {
    expect(refusalOf(new ApiError(401, "UNAUTHENTICATED", "Unknown bearer token"))).toBe(
      "Unknown bearer token",
    );
  });

  it("says what the browser itself threw, rather than that something went wrong", () => {
    expect(refusalOf(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
    expect(refusalOf("nope")).toBe("nope");
  });
});
