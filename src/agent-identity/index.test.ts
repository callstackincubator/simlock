import { describe, expect, it } from "vitest";

import { resolveRequesterId } from "./index.js";

describe("resolveRequesterId", () => {
  it("returns SIMLOCK_AGENT_ID unchanged when it is defined, even with a Claude Code session id also set", () => {
    expect(
      resolveRequesterId(
        { SIMLOCK_AGENT_ID: "agent-7", CLAUDE_CODE_SESSION_ID: "abc" },
        "fallback",
      ),
    ).toBe("agent-7");
  });

  it("returns claude-code:<id> from CLAUDE_CODE_SESSION_ID when SIMLOCK_AGENT_ID is unset", () => {
    expect(resolveRequesterId({ CLAUDE_CODE_SESSION_ID: "abc" }, "fallback")).toBe(
      "claude-code:abc",
    );
  });

  it("returns codex:<id> from CODEX_SESSION_ID when SIMLOCK_AGENT_ID is unset", () => {
    expect(resolveRequesterId({ CODEX_SESSION_ID: "xyz" }, "fallback")).toBe("codex:xyz");
  });

  it("takes CLAUDE_CODE_SESSION_ID over CODEX_SESSION_ID when both are set", () => {
    expect(
      resolveRequesterId({ CLAUDE_CODE_SESSION_ID: "abc", CODEX_SESSION_ID: "xyz" }, "fallback"),
    ).toBe("claude-code:abc");
  });

  it("skips a session variable set to the empty string and takes the next row", () => {
    expect(
      resolveRequesterId({ CLAUDE_CODE_SESSION_ID: "", CODEX_SESSION_ID: "xyz" }, "fallback"),
    ).toBe("codex:xyz");
  });

  it("returns the caller's fallback when no variable is set", () => {
    expect(resolveRequesterId({}, "fallback")).toBe("fallback");
  });
});
