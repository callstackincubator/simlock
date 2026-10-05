import { describe, expect, it } from "vitest";

import { findCatalogModel } from "./catalog-match.js";

describe("findCatalogModel", () => {
  const entry = {
    modelAliases: { "Pixel 8": ["pixel_8", "P8"], "Pixel 9": ["pixel_9"] },
    models: ["Pixel 9", "Pixel 8"],
  };

  it("matches a model name in any letter case and returns the listed spelling", () => {
    expect(findCatalogModel(entry, "pIxEl 8")).toBe("Pixel 8");
  });

  it("matches an alias in any letter case and returns the model it belongs to", () => {
    expect(findCatalogModel(entry, "PIXEL_9")).toBe("Pixel 9");
    expect(findCatalogModel(entry, "p8")).toBe("Pixel 8");
  });

  it("returns the first listed model whose name or alias matches", () => {
    expect(
      findCatalogModel(
        { modelAliases: { "Pixel 8": ["Pixel 9"] }, models: ["Pixel 8", "Pixel 9"] },
        "pixel 9",
      ),
    ).toBe("Pixel 8");
  });

  it("returns undefined for a name nothing lists", () => {
    expect(findCatalogModel(entry, "Pixel 10")).toBeUndefined();
  });

  it("ignores inherited keys, so a model named constructor reads no aliases off Object.prototype", () => {
    expect(
      findCatalogModel({ modelAliases: {}, models: ["constructor"] }, "tostring"),
    ).toBeUndefined();
    expect(findCatalogModel({ modelAliases: {}, models: ["constructor"] }, "constructor")).toBe(
      "constructor",
    );
  });
});
