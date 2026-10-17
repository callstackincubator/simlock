#!/usr/bin/env node
// Summarize a per-PR invocation ledger: node .agents/scripts/review-metrics.mjs ledger.json
import { readFileSync } from "node:fs";

const ledger = JSON.parse(readFileSync(process.argv[2], "utf8"));
const invocations = ledger.invocations;
if (!Array.isArray(invocations) || invocations.length === 0) {
  throw new Error("invocations must be a nonempty array");
}
const ids = new Set();
const knownNumber = (value) => value === null || (Number.isFinite(value) && value >= 0);
for (const item of invocations) {
  if (!item.id || ids.has(item.id)) throw new Error("invocation IDs must be unique");
  ids.add(item.id);
  for (const key of ["role", "provider", "model", "commit"]) {
    if (typeof item[key] !== "string" || !item[key]) throw new Error(`missing ${key}`);
  }
  if (!["1", "2", "fix-check"].includes(item.round)) throw new Error("invalid round");
  for (const key of ["costUsd", "fixSeconds"]) {
    if (!knownNumber(item[key])) throw new Error(`invalid ${key}; use null for unknown`);
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!knownNumber(item.tokens?.[key])) throw new Error(`invalid tokens.${key}`);
  }
  for (const key of ["startedAt", "finishedAt"]) {
    if (item[key] !== null && !Number.isFinite(Date.parse(item[key]))) {
      throw new Error(`invalid ${key}; use null for unknown`);
    }
  }
  if (
    item.startedAt !== null &&
    item.finishedAt !== null &&
    Date.parse(item.finishedAt) < Date.parse(item.startedAt)
  ) {
    throw new Error("finish precedes start");
  }
}
const total = (values) =>
  values.some((v) => v === null) ? null : values.reduce((a, b) => a + b, 0);
const show = (value) => (value === null ? "unknown" : String(value));
const checks = new Set(
  invocations
    .filter((v) => ["spec", "code", "claims"].includes(v.role))
    .map((v) => `${v.round}:${v.commit}`),
).size;
const cost = total(invocations.map((v) => v.costUsd));
const elapsed = invocations.some((v) => v.startedAt === null || v.finishedAt === null)
  ? null
  : (Math.max(...invocations.map((v) => Date.parse(v.finishedAt))) -
      Math.min(...invocations.map((v) => Date.parse(v.startedAt)))) /
    1000;
console.log(
  `Review checks: ${checks}. Invocations: ${invocations.length}. Cost USD: ${show(cost)}.`,
);
console.log(
  `Review elapsed seconds: ${show(elapsed)}. Fix effort seconds: ${show(total(invocations.map((v) => v.fixSeconds)))}.`,
);
for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
  console.log(`Review tokens ${key}: ${show(total(invocations.map((v) => v.tokens[key])))}.`);
}
const findings = ledger.findings ?? [];
const findingIds = new Set();
for (const finding of findings) {
  if (!finding.id || findingIds.has(finding.id)) throw new Error("finding IDs must be unique");
  findingIds.add(finding.id);
  if (
    !["open", "fixed", "duplicate", "incorrect", "intentional", "nonblocking"].includes(
      finding.outcome,
    )
  ) {
    throw new Error("invalid finding outcome");
  }
}
for (const finding of findings.filter((f) => f.outcome === "duplicate")) {
  if (!findings.some((f) => f.id === finding.canonicalId && f.outcome !== "duplicate")) {
    throw new Error("duplicate must reference a canonical finding");
  }
}
console.log(
  `Finding outcomes: ${JSON.stringify(Object.fromEntries(["open", "fixed", "duplicate", "incorrect", "intentional", "nonblocking"].map((outcome) => [outcome, findings.filter((f) => f.outcome === outcome).length])))}.`,
);
console.log(
  `Escaped defects: ${ledger.escapedDefects === null || ledger.escapedDefects === undefined ? "unknown" : JSON.stringify(ledger.escapedDefects)}.`,
);
