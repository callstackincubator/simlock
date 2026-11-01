import { describe, expect, it } from "vitest";

import { parseOrientation } from "./orientation.js";

// why: a parser with many spellings, each a row; it has no surface above it that lists them.
describe("parseOrientation", () => {
  it("maps a spelling to an orientation, ignoring case and surrounding space, or to the unknown message", () => {
    const accepted: readonly (readonly [string, string])[] = [
      ["landscape_left", "landscape_left"],
      ["landscape-left", "landscape_left"],
      ["LEFT", "landscape_left"],
      ["  Left ", "landscape_left"],
      ["landscape_right", "landscape_right"],
      ["landscape-right", "landscape_right"],
      ["right", "landscape_right"],
      ["portrait_upside_down", "portrait_upside_down"],
      ["portrait-upside-down", "portrait_upside_down"],
      ["upside-down", "portrait_upside_down"],
      ["portrait", "portrait"],
      ["PORTRAIT", "portrait"],
    ];
    for (const [spelling, orientation] of accepted) {
      expect(parseOrientation(spelling), spelling).toEqual({ ok: true, orientation });
    }

    for (const spelling of ["auto", "landscapeLeft", "", "   ", "up", "landscape"]) {
      expect(parseOrientation(spelling), JSON.stringify(spelling)).toEqual({
        message: `Unknown orientation ${spelling}; use portrait, portrait-upside-down, landscape-left or landscape-right`,
        ok: false,
      });
    }
  });
});
