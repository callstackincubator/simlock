import { describe, expect, it } from "vitest";

import { resolveAgentRole } from "./hello.js";

describe("resolveAgentRole", () => {
  it("resolves agent unconditionally, regardless of what hello sends", () => {
    expect(resolveAgentRole.resolve({})).toBe("agent");
    expect(resolveAgentRole.resolve({ credential: "anything", principal: "someone" })).toBe(
      "agent",
    );
  });
});
