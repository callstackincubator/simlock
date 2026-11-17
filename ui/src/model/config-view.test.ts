import { describe, expect, it } from "vitest";

import { configSections, setCommand } from "./config-view";

describe("configSections", () => {
  it("groups the leaves under their top-level key, as dotted paths", () => {
    const sections = configSections({
      mode: "worker",
      lease: { defaultTtlMs: 600000, nested: { on: true } },
      downloads: { policy: "never" },
    });

    expect(sections.map((section) => section.name)).toEqual(["downloads", "lease", "mode"]);
    expect(sections[1]?.entries).toEqual([
      { key: "lease.defaultTtlMs", masked: false, value: "600000" },
      { key: "lease.nested.on", masked: false, value: "true" },
    ]);
    expect(sections[2]?.entries).toEqual([{ key: "mode", masked: false, value: "worker" }]);
  });

  it("keeps a list whole as JSON and an empty object as {}", () => {
    const [caps, warm] = configSections({
      capabilities: { x: {} },
      warmPool: { targets: [{ platform: "ios", count: 1 }] },
    });

    expect(warm?.entries[0]?.value).toBe('[{"platform":"ios","count":1}]');
    expect(caps?.entries).toEqual([{ key: "capabilities.x", masked: false, value: "{}" }]);
  });

  it("marks a value the daemon masked", () => {
    const [gateway] = configSections({ gateway: { token: "[redacted]", url: "http://x" } });

    expect(gateway?.entries.map((entry) => entry.masked)).toEqual([true, false]);
  });

  it("has no sections for an empty config", () => {
    expect(configSections({})).toEqual([]);
  });
});

describe("setCommand", () => {
  it("quotes a value the shell would split", () => {
    expect(setCommand("lease.defaultTtlMs", "600000")).toBe(
      "simlock config set lease.defaultTtlMs 600000",
    );
    expect(setCommand("a.b", `it's [1, 2]`)).toBe("simlock config set a.b 'it'\\''s [1, 2]'");
  });
});
