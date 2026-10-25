// Claude Code's transcripts, for the scripts that measure agent runs: review-metrics.mjs,
// instruction-reads.mjs and delivery-counters.mjs. A run is a transcript whose first user
// message starts with the ledger tag line (`toolchain.md`, "Review measurement").
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const projectsRoot = () =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

export function transcripts(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...transcripts(path));
    else if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

// why: transcripts run to hundreds of megabytes; the tag is in the first user record, near the top.
export function tagOf(file) {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(256 * 1024);
  const read = readSync(fd, head, 0, head.length, 0);
  closeSync(fd);
  for (const line of head.subarray(0, read).toString("utf8").split("\n")) {
    const rec = parsed(line);
    if (rec?.type !== "user") continue;
    const first = promptOf(rec).split("\n")[0].trim();
    if (!first.startsWith("ledger:")) return null;
    const tag = { pr: "-", issue: "-", stage: "-", round: "-", role: "-", lens: "-" };
    for (const [, key, value] of first.matchAll(/(\w+)=(\S+)/g))
      if (key in tag) tag[key] = value.replace(/^#/, "");
    return tag;
  }
  return null;
}

export function taggedRuns(root = projectsRoot()) {
  return transcripts(root)
    .map((file) => ({ file, tag: tagOf(file) }))
    .filter(({ tag }) => tag !== null);
}

export function runOf(file) {
  const records = readFileSync(file, "utf8").split("\n").map(parsed).filter(Boolean);
  const first = records.find((r) => r.type === "user");
  const blocks = assistantBlocks(records);
  return {
    prompt: first ? promptOf(first) : "",
    toolInputs: blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => JSON.stringify(b.input ?? {})),
    lastText: blocks.filter((b) => b.type === "text" && b.text?.trim()).at(-1)?.text ?? "",
    startedAt: records.map((r) => r.timestamp).find((t) => typeof t === "string") ?? null,
  };
}

// why: one API message is written as several records with the same id; its blocks count once.
function assistantBlocks(records) {
  const seen = new Set();
  const blocks = [];
  for (const r of records) {
    if (r.type !== "assistant" || !r.message?.id || seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    blocks.push(...(r.message.content ?? []));
  }
  return blocks;
}

export function promptOf(rec) {
  const content = rec.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content.find((b) => b.type === "text")?.text ?? "") : "";
}

export function parsed(line) {
  if (line === "") return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
