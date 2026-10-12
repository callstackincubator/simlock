import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "usage.mjs",
);

const message = (id: string, model: string, usage: Record<string, number>) =>
  JSON.stringify({ type: "assistant", message: { id, model, usage, content: [] } });

function session(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const main = join(dir, "s1.jsonl");
  writeFileSync(
    main,
    [
      message("m1", "model-a", {
        input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        output_tokens: 100_000,
      }),
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  writeFileSync(
    join(dir, "s1", "subagents", "agent-a1.jsonl"),
    [
      message("m2", "model-b", { input_tokens: 400_000 }),
      message("m2", "model-b", { input_tokens: 400_000 }),
      JSON.stringify({ type: "user", message: { content: "not an api message" } }),
      "not json at all",
      "",
    ].join("\n"),
  );
  return main;
}

function run(args: readonly string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_TRANSCRIPT_PATH: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

describe("usage.mjs", () => {
  it("weights input, cache reads and output, counts a message written on two lines once, and sums per model", () => {
    const result = run([session()]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("tokens=2.0M turns=2 agents=1\n  model-a 1.6M\n  model-b 0.4M\n");
  });

  it("reads the transcript from CLAUDE_TRANSCRIPT_PATH when none is given, and fails without either", () => {
    const main = session();

    expect(run([], { CLAUDE_TRANSCRIPT_PATH: main }).stdout).toContain("tokens=2.0M");
    expect(run([]).status).toBe(64);
  });
});
