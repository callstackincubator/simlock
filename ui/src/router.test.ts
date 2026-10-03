import { describe, expect, it } from "vitest";

import { opensInThisTab } from "./router";

const plain = { altKey: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false };

describe("opensInThisTab", () => {
  it("handles a plain primary click in the console, and leaves every other click to the browser", () => {
    expect(opensInThisTab(plain)).toBe(true);
    // A middle click, or a click with a modifier, opens a new tab or window as it always does.
    expect(opensInThisTab({ ...plain, button: 1 })).toBe(false);
    for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(opensInThisTab({ ...plain, [key]: true }), key).toBe(false);
    }
  });
});
