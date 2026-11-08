import { describe, expect, it } from "vitest";

import { agentKind, shortHolder } from "./holder";

describe("a holder's identity", () => {
  it("shortens a holder id in the middle above 34 code units and names a tool only for an exact prefix", () => {
    const exact34 = "claude-code:3f2a9c8b7d6e5f4a3b2c1d";
    const overByOne = "claude-code:3f2a9c8b7d6e5f4a3b2c1d0";
    const freeForm = `${"f".repeat(250)}z2y8x7`;
    // why: the bound counts JavaScript code units, and an astral character takes two of them, so an
    // id of 34 characters is already over the bound and gets cut.
    const astral = `pi:\u{1F600}${"b".repeat(30)}`;

    expect(exact34).toHaveLength(34);
    expect(overByOne).toHaveLength(35);
    expect(freeForm).toHaveLength(256);
    expect([...astral]).toHaveLength(34);
    expect(astral).toHaveLength(35);

    const cuts: readonly [string, string][] = [
      ["", ""],
      [exact34, exact34],
      [overByOne, "claude-code:3f2a9c8b7d6e5…b2c1d0"],
      [freeForm, `${"f".repeat(25)}…z2y8x7`],
      [astral, `pi:\u{1F600}${"b".repeat(20)}…${"b".repeat(6)}`],
    ];
    for (const [id, wanted] of cuts) {
      expect(shortHolder(id), JSON.stringify(id)).toBe(wanted);
    }

    const kinds: readonly [string, string][] = [
      ["", "unknown"],
      ["claude-code:3f2a9c8b7d6e5", "claude-code"],
      ["codex:session-0123456789", "codex"],
      ["cursor:nav-redesign", "cursor"],
      ["pi:8f2c", "pi"],
      ["mcp:48213", "unknown"],
      ["ci-runner-3", "unknown"],
      ["codex/free-label", "unknown"],
      ["runner:codex:session-0123456789", "unknown"],
      ["Claude-Code:3f2a9c8b7d6e5", "unknown"],
      ["claude-code", "unknown"],
      ["pi", "unknown"],
      [freeForm, "unknown"],
    ];
    for (const [id, wanted] of kinds) {
      expect(agentKind(id), JSON.stringify(id)).toBe(wanted);
    }
  });
});
