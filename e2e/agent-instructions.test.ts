import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { AGENT_INSTRUCTIONS } from "../src/instructions/index.js";
import { withDaemon } from "./helpers/index.js";

describe("simlock instructions", () => {
  it("prints the rules text on stdout, or as one JSON object, and exits 0 without starting a daemon", async () => {
    const env = await withDaemon({ mode: "auto" });

    const plain = await env.cli(["instructions"]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).toBe(AGENT_INSTRUCTIONS);

    const json = await env.cli(["instructions", "--json"]);
    expect(json.code).toBe(0);
    expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(json.json).toEqual({ instructions: plain.stdout });

    const help = await env.cli(["instructions", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe("Usage: simlock instructions [--json]\n");

    for (const argv of [
      ["instructions", "--bogus"],
      ["instructions", "extra"],
    ]) {
      const refused = await env.cli(argv);
      expect(refused.code, argv.join(" ")).toBe(2);
      expect(refused.stdout, argv.join(" ")).toBe("");
      expect(refused.error?.code, argv.join(" ")).toBe("USAGE");
    }

    // why: `mode: "auto"` leaves the daemon unstarted; any daemon-touching command would have
    // auto-started one and left its socket here.
    expect(existsSync(env.socketPath)).toBe(false);
  });
});
