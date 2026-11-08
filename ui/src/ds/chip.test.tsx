import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentChip } from "./index";

type AgentKind = ComponentProps<typeof AgentChip>["kind"];

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
