#!/usr/bin/env node
// `node .agents/scripts/codex-agents.mjs [--check]`: writes .codex/agents/<name>.toml, one Codex
// custom agent per .claude/agents/<name>.md with the same name, description and instructions;
// the model comes from .agents/codex-models.json (a Claude tier maps to a Codex model, an agent
// may name its own), the effort from the file. Codex reads .codex/agents/ from the checkout it
// runs in, worktrees included, so the generated files are committed: run this after a change to
// an agent file or to the model map. --check writes nothing and exits 1 naming every twin that
// is stale or orphaned; codex-agents.test.ts runs it, so a stale twin fails the tests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function agentToml(file, models) {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${file}: no frontmatter`);
  const front = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv !== null) front[kv[1]] = kv[2].trim();
  }
  const name = front.name ?? path.basename(file, ".md");
  const model = models.agents[name] ?? models.tiers[front.model];
  if (model === undefined) throw new Error(`${file}: no Codex model for tier "${front.model}"`);
  const body = match[2].trim();
  if (body.includes("'''")) throw new Error(`${file}: the body holds ''' and cannot be quoted`);
  const lines = [
    `# Generated from .claude/agents/${path.basename(file)} by .agents/scripts/codex-agents.mjs; edit that file.`,
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(front.description ?? "")}`,
    `model = ${JSON.stringify(model)}`,
  ];
  if (front.effort !== undefined)
    lines.push(`model_reasoning_effort = ${JSON.stringify(front.effort)}`);
  lines.push("developer_instructions = '''", body, "'''", "");
  return { name, toml: lines.join("\n") };
}

export function agentFiles(root) {
  const models = JSON.parse(
    fs.readFileSync(path.join(root, ".agents", "codex-models.json"), "utf8"),
  );
  const sources = path.join(root, ".claude", "agents");
  const files = new Map();
  for (const entry of fs
    .readdirSync(sources)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    const { name, toml } = agentToml(path.join(sources, entry), models);
    files.set(path.join(root, ".codex", "agents", `${name}.toml`), toml);
  }
  return files;
}

export function stale(root) {
  const files = agentFiles(root);
  const dir = path.join(root, ".codex", "agents");
  const result = [];
  for (const [file, toml] of files) {
    let current = null;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {}
    if (current !== toml) result.push(file);
  }
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, entry);
    if (entry.endsWith(".toml") && !files.has(file)) result.push(file);
  }
  return result.sort();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const files = stale(ROOT);
    if (files.length > 0) {
      console.error("Stale Codex agents; run `node .agents/scripts/codex-agents.mjs`:");
      for (const file of files) console.error(`  ${path.relative(ROOT, file)}`);
      process.exit(1);
    }
    console.log("Codex agents are current.");
  } else {
    const files = agentFiles(ROOT);
    const dir = path.join(ROOT, ".codex", "agents");
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, toml] of files) fs.writeFileSync(file, toml);
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      if (entry.endsWith(".toml") && !files.has(file)) fs.rmSync(file);
    }
    console.log(`Wrote ${files.size} agents under ${path.relative(ROOT, dir)}.`);
  }
}
