import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type AgentKind, AgentChip } from "./chip";

// why: testing 6 — the line names this file's seam: AgentChip through its public props, drawn with
// renderToStaticMarkup as menu.test.tsx does. The kind arrives as a value because a screen computes
// it and the DS may not read the model.
describe("a holder's chip", () => {
  it("prints two mono capitals for a known tool, a dot for any other holder, and the whole id in its title", () => {
    const known: readonly [AgentKind, string][] = [
      ["claude-code", "CC"],
      ["codex", "CX"],
      ["cursor", "CU"],
      ["pi", "PI"],
    ];
    for (const [kind, printed] of known) {
      const markup = renderToStaticMarkup(<AgentChip kind={kind} title="claude-code:s-1" />);
      expect(markup).toContain(`chip-agent-${kind}`);
      expect(/chip-mark">([^<]*)</.exec(markup)?.[1]).toBe(printed);
      expect(markup).toContain('title="claude-code:s-1"');
      expect(markup).not.toContain("chip-dot");
    }

    const plain = renderToStaticMarkup(<AgentChip kind="unknown" title="mcp:48213" />);
    expect(plain).toContain("chip-agent-unknown");
    expect(plain).toContain("chip-dot");
    expect(plain).not.toContain("chip-mark");
    expect(plain).toContain('title="mcp:48213"');

    const bare = renderToStaticMarkup(<AgentChip kind="pi" />);
    expect(bare).toContain("chip-agent-pi");
    expect(bare).not.toContain("title=");
  });
});
