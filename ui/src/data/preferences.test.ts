import { describe, expect, it } from "vitest";

import { createPreferences } from "./preferences";

function memory(): Pick<Storage, "getItem" | "setItem"> & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    items,
    setItem: (key, value) => void items.set(key, value),
  };
}

describe("the console's preferences", () => {
  it("keeps the sidebar width the viewer chose, for the next page load", () => {
    const storage = memory();

    createPreferences(() => storage).setSidebar("narrow");

    expect(createPreferences(() => storage).sidebar()).toBe("narrow");
  });

  it("has no sidebar width until one is chosen, and ignores a value it did not write", () => {
    const storage = memory();
    expect(createPreferences(() => storage).sidebar()).toBeUndefined();

    storage.items.set("simlock.sidebar", "huge");

    expect(createPreferences(() => storage).sidebar()).toBeUndefined();
  });

  it("works without storage in a browser that blocks site data", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    const preferences = createPreferences(blocked);

    expect(() => preferences.setSidebar("wide")).not.toThrow();
    expect(preferences.sidebar()).toBeUndefined();
  });
});
