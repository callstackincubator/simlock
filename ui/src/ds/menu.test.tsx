import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionBar, type MenuEntry } from "./menu";

const entry = (label: string, danger: boolean): MenuEntry => ({
  danger,
  disabled: false,
  key: label,
  label,
  onSelect: () => {},
});

describe("the action bar", () => {
  it("draws no ⋯ when its only safe entry is the button, and keeps the ⋯ for any other entry", () => {
    const draw = (entries: readonly MenuEntry[]) =>
      renderToStaticMarkup(<ActionBar label="Actions for bar-a" entries={entries} />);

    const onlyButton = draw([entry("Undrain", false)]);
    expect(onlyButton).toContain("Undrain");
    expect(onlyButton).not.toContain('aria-label="Actions for bar-a"');

    const withDanger = draw([entry("Undrain", false), entry("Remove worker", true)]);
    expect(withDanger).toContain("Undrain</button>");
    expect(withDanger).toContain('aria-label="Actions for bar-a"');

    const dangerOnly = draw([entry("Release lease", true)]);
    expect(dangerOnly).not.toContain("button-secondary");
    expect(dangerOnly).toContain('aria-label="Actions for bar-a"');
  });
});
