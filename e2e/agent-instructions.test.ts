import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_INSTRUCTIONS } from "../src/instructions/index.js";
import { withDaemon } from "./helpers/index.js";

describe("simlock instructions", () => {
  it("prints the agent instructions on stdout and exits 0 without starting a daemon", async () => {
    const env = await withDaemon({ mode: "auto" });

    const result = await env.cli(["instructions"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(AGENT_INSTRUCTIONS);
    // `mode: "auto"` leaves the daemon unstarted; any daemon-touching command would have
    // auto-started one and left its socket here.
    expect(existsSync(env.socketPath)).toBe(false);
  });

  it("--json prints one JSON object whose instructions field equals the text output", async () => {
    const env = await withDaemon({ mode: "auto" });

    const text = await env.cli(["instructions"]);
    const json = await env.cli(["instructions", "--json"]);

    expect(json.code).toBe(0);
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(json.json).toEqual({ instructions: text.stdout });
  });

  it("--bogus fails with USAGE and exit 2", async () => {
    const env = await withDaemon({ mode: "auto" });

    const result = await env.cli(["instructions", "--bogus"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.error?.code).toBe("USAGE");
  });
});
