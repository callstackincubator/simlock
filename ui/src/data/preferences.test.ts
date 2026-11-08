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
    expect(preferences.sidebar()).toBe("wide");
  });

  describe("the settings", () => {
    it("are the defaults when nothing is stored", () => {
      expect(createPreferences(() => memory()).settings()).toEqual({
        holders: "short",
        range: "1h",
        rows: 25,
        theme: "system",
      });
    });

    it("keep a change for the next page load and tell the subscribers", () => {
      const storage = memory();
      const preferences = createPreferences(() => storage);
      let told = 0;
      const stop = preferences.subscribe(() => (told += 1));

      preferences.change({ rows: 100, theme: "dark" });
      stop();
      preferences.change({ holders: "full" });

      expect(told).toBe(1);
      expect(createPreferences(() => storage).settings()).toEqual({
        holders: "full",
        range: "1h",
        rows: 100,
        theme: "dark",
      });
    });

    it("fall back to the defaults on bad JSON, and field by field on a bad value", () => {
      const storage = memory();
      storage.items.set("simlock.settings", "{not json");
      expect(createPreferences(() => storage).settings().theme).toBe("system");

      storage.items.set(
        "simlock.settings",
        JSON.stringify({ range: "9y", rows: 50, theme: "neon" }),
      );
      expect(createPreferences(() => storage).settings()).toEqual({
        holders: "short",
        range: "1h",
        rows: 50,
        theme: "system",
      });
    });

    it("hold for the session when storage throws", () => {
      const blocked = () => {
        throw new Error("SecurityError");
      };
      const preferences = createPreferences(blocked);

      expect(preferences.settings().theme).toBe("system");
      expect(() => preferences.change({ theme: "light" })).not.toThrow();
      expect(preferences.settings().theme).toBe("light");
    });
  });
});
