import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LABELS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "labels.json");

interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const labels = JSON.parse(readFileSync(LABELS, "utf8")) as readonly Label[];

// The Labels workflow syncs this file to GitHub on every push to main. GitHub rejects the whole
// sync on the first label it refuses, so one bad entry silently leaves every later label
// uncreated.
describe(".github/labels.json", () => {
  it.each(labels.map((label) => [label.name, label] as const))(
    "%s is a label GitHub accepts: name up to 50 characters, description up to 100, a six-digit hex color",
    (_name, label) => {
      expect(label.name.length).toBeGreaterThan(0);
      expect(label.name.length).toBeLessThanOrEqual(50);
      expect(label.description.length).toBeLessThanOrEqual(100);
      expect(label.color).toMatch(/^[0-9a-f]{6}$/i);
    },
  );

  it("names each label once", () => {
    const names = labels.map((label) => label.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});
