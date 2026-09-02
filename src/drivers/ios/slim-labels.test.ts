import { describe, expect, it } from "vitest";

import {
  labelsFor,
  resolveSlimCategories,
  SLIM_CATEGORIES,
  SLIM_CATEGORY_NAMES,
  slimSignature,
} from "./slim-labels.js";

describe("SLIM_CATEGORIES", () => {
  it("every category has at least one label", () => {
    for (const category of SLIM_CATEGORIES) {
      expect(category.labels.length).toBeGreaterThan(0);
    }
  });

  it("no label is empty", () => {
    for (const category of SLIM_CATEGORIES) {
      for (const label of category.labels) {
        expect(label.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("SLIM_CATEGORY_NAMES matches the category list", () => {
    expect(SLIM_CATEGORY_NAMES).toEqual(SLIM_CATEGORIES.map((c) => c.name));
  });
});

describe("resolveSlimCategories", () => {
  it("resolves to every category when undefined", () => {
    const { categories, unknown } = resolveSlimCategories(undefined);
    expect(categories).toEqual(SLIM_CATEGORIES);
    expect(unknown).toEqual([]);
  });

  it("resolves a subset by name, preserving requested order", () => {
    const { categories, unknown } = resolveSlimCategories(["telemetry", "siri"]);
    expect(categories.map((c) => c.name)).toEqual(["telemetry", "siri"]);
    expect(unknown).toEqual([]);
  });

  it("dedupes repeated requested names", () => {
    const { categories } = resolveSlimCategories(["siri", "siri"]);
    expect(categories.map((c) => c.name)).toEqual(["siri"]);
  });

  it("reports unknown names separately instead of throwing", () => {
    const { categories, unknown } = resolveSlimCategories(["siri", "bogus", "also-bogus"]);
    expect(categories.map((c) => c.name)).toEqual(["siri"]);
    expect(unknown).toEqual(["bogus", "also-bogus"]);
  });

  it("resolves an empty request to no categories", () => {
    const { categories, unknown } = resolveSlimCategories([]);
    expect(categories).toEqual([]);
    expect(unknown).toEqual([]);
  });
});

describe("labelsFor", () => {
  it("dedupes labels shared across categories and sorts them", () => {
    const store = SLIM_CATEGORIES.find((c) => c.name === "store")!;
    const icloud = SLIM_CATEGORIES.find((c) => c.name === "icloud")!;
    // store and icloud both list com.apple.amsaccountsd et al.
    const labels = labelsFor([store, icloud]);
    const asSet = new Set(labels);
    expect(asSet.size).toBe(labels.length);
    expect([...labels]).toEqual([...labels].sort());
    expect(labels).toContain("com.apple.amsaccountsd");
  });

  it("returns an empty array for no categories", () => {
    expect(labelsFor([])).toEqual([]);
  });

  it("is deterministic across calls", () => {
    const first = labelsFor(SLIM_CATEGORIES);
    const second = labelsFor(SLIM_CATEGORIES);
    expect(first).toEqual(second);
  });
});

describe("slimSignature", () => {
  it("is stable for the same input", () => {
    const a = slimSignature(SLIM_CATEGORIES);
    const b = slimSignature(SLIM_CATEGORIES);
    expect(a).toBe(b);
  });

  it("is stable regardless of input category order", () => {
    const forward = slimSignature(SLIM_CATEGORIES);
    const reversed = slimSignature([...SLIM_CATEGORIES].reverse());
    expect(forward).toBe(reversed);
  });

  it("is prefixed with a schema version", () => {
    expect(slimSignature(SLIM_CATEGORIES)).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  it("changes when the set of categories changes", () => {
    const all = slimSignature(SLIM_CATEGORIES);
    const subset = slimSignature(SLIM_CATEGORIES.slice(0, -1));
    expect(all).not.toBe(subset);
  });

  it("changes when a category's labels change", () => {
    const original = SLIM_CATEGORIES[0]!;
    const mutated = { ...original, labels: [...original.labels, "com.apple.made-up-daemon"] };
    const before = slimSignature([original]);
    const after = slimSignature([mutated]);
    expect(before).not.toBe(after);
  });

  it("returns the same signature for an empty category list regardless of call site", () => {
    expect(slimSignature([])).toBe(slimSignature([]));
  });
});
