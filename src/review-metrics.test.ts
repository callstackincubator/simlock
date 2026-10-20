import { spawnSync } from "node:child_process";
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
  "review-metrics.mjs",
);

const prompt = (text: string, at: string) =>
  JSON.stringify({ type: "user", timestamp: at, message: { content: text } });
const reply = (id: string, model: string, at: string, usage: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage, content: [] } });

function home(transcripts: Record<string, string[]>): string {
  const config = mkdtempSync(join(tmpdir(), "review-metrics-"));
  for (const [path, lines] of Object.entries(transcripts)) {
    const file = join(config, "projects", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join("\n")}\n`);
  }
  return config;
}

function metrics(config: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

const T0 = "2026-10-19T10:00:00.000Z";
const T1 = "2026-10-19T10:00:30.000Z";

describe("review-metrics.mjs", () => {
  it("adds up the runs whose prompt's first line tags the PR, or its issue with --issue, a subagent's included, each API message once, priced per model and cache tier", () => {
    const config = home({
      "a/s1.jsonl": [
        prompt("ledger: pr=7 issue=3 stage=review round=1 role=code lens=tests\nreview", T0),
        reply("m1", "claude-opus-5-5", T0, {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
        }),
        reply("m1", "claude-opus-5-5", T1, {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
        }),
      ],
      "a/s0/subagents/agent-x.jsonl": [
        prompt("ledger: pr=- issue=3 stage=red round=- role=implementer lens=-\nbuild", T0),
        reply("m2", "claude-sonnet-5-5", T1, {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 1_000_000,
        }),
      ],
      "b/other-pr.jsonl": [
        prompt("ledger: pr=8 issue=4 stage=review round=1 role=spec lens=-\nreview", T0),
        reply("m3", "claude-opus-5-5", T1, { input_tokens: 5_000_000 }),
      ],
      "b/untagged.jsonl": [
        prompt("review it, pr=7 issue=3 role=code", T0),
        reply("m4", "claude-opus-5-5", T1, { input_tokens: 5_000_000 }),
      ],
    });

    const prOnly = metrics(config, "--pr", "7");
    const withIssue = metrics(config, "--pr", "7", "--issue", "3");

    // why: Opus 4 + 2 (100k out at 20) + 0.2 + 8 (1h write) = 14.2; Sonnet 0.1 + 2.5 (5m write) = 2.6.
    expect(prOnly.out).toContain("Runs: 1. Cost USD: 14.2. Agent seconds: 30.");
    expect(withIssue.out).toContain("Runs: 2. Cost USD: 16.8. Agent seconds: 60.");
    expect(withIssue.out).toContain(
      "Tokens input 1000000, output 100000, cache read 2000000, cache write 2000000.",
    );
    expect(withIssue.out).toContain("- review 1 code tests: claude-opus-5-5 30 s $14.2");
    expect(withIssue.out).toContain("- red implementer: claude-sonnet-5-5 30 s $2.6");
  });

  it("reports cost as unknown, never zero, for a model it has no price for and for a PR with no tagged run", () => {
    const config = home({
      "a/s1.jsonl": [
        prompt("ledger: pr=7 stage=review role=code\nreview", T0),
        reply("m1", "some-new-model", T1, { input_tokens: 10 }),
      ],
    });

    expect(metrics(config, "--pr", "7").out).toContain("Runs: 1. Cost USD: unknown.");
    expect(metrics(config, "--pr", "9").out).toContain(
      "Runs: 0. Cost USD: unknown. Agent seconds: unknown.",
    );
  });

  it("with --findings counts outcomes and classes, and refuses a duplicate that names no canonical finding", () => {
    const config = home({});
    const dir = mkdtempSync(join(tmpdir(), "findings-"));
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    const finding = (id: string, outcome: string, more: Record<string, string> = {}) => ({
      id,
      role: "code",
      class: "testing 2",
      path: "src/a.ts:1",
      outcome,
      ...more,
    });
    writeFileSync(
      good,
      JSON.stringify({
        findings: [
          finding("R1", "fixed"),
          finding("R2", "duplicate", { canonicalId: "R1" }),
          finding("R3", "incorrect", { class: "architecture 13" }),
        ],
      }),
    );
    writeFileSync(bad, JSON.stringify({ findings: [finding("R1", "duplicate")] }));

    const ok = metrics(config, "--pr", "7", "--findings", good);
    const refused = metrics(config, "--pr", "7", "--findings", bad);

    expect(ok.out).toContain(
      'Finding outcomes: {"duplicate":1,"fixed":1,"incorrect":1}. Classes: {"architecture 13":1,"testing 2":2}.',
    );
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("duplicate R1 must name a canonical finding");
  });
});
