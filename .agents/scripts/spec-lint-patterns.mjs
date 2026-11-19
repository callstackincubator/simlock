import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TASK_H2 = ["Scope", "Technical spec", "Done when", "Out of scope", "Depends on"];
export const TASK_H3 = [
  "Rows",
  "Facts",
  "Modules touched",
  "Rules in play",
  "Retired words",
  "Tests",
];
// why: tasks and features written before the design tables keep their layout until they close.
export const OLD_TASK_H2 = [
  "Scope",
  "In short",
  "Technical spec",
  "Done when",
  "Out of scope",
  "Depends on",
];
export const OLD_TASK_H3 = [
  "Facts",
  "Modules touched",
  "Surface and extension points",
  "Contract and event changes",
  "Other code on the same state",
  "Failure modes",
  "Rules in play",
  "Retired words",
  "Tests",
];
export const OPTIONAL = new Set(["Surface and extension points", "Retired words"]);
const BUSINESS_H2 = [
  "Problem",
  "Who it is for",
  "Outcome",
  "How it works for the user",
  "Examples",
  "What could go wrong",
  "Words used",
  "Non-goals",
  "Completion conditions",
  "Open questions",
  "Decisions",
];
export const DESIGN = [
  ["Behaviours", "B"],
  ["Stored state", "S"],
  ["Interfaces", "I"],
  ["Existing code", "X"],
];
export const FEATURE_H2 = [...BUSINESS_H2, ...DESIGN.map(([name]) => name), "Tasks"];
export const OLD_FEATURE_H2 = [...BUSINESS_H2, "Shared values", "Behaviours", "Tasks"];
export const SCHEMA_STEP = /^([\w-]+) \+(\d+)$/;
export const REFACTOR_H2 = ["Why", "Target shape", "Out of bounds", "Done when"];
export const FAILURE_HEADER = ["Call", "Outcome", "What happens", "Limit, counted from"];
export const CANNOT_SPLIT =
  /\b(cannot|can't|can not|does not|doesn't|won't) split\b|\bone task, not\b|\bkept? (it )?whole\b/i;
export const HARDWARE = /slow lane|real (simulator|emulator|device|iPhone|phone)|on a Mac with/i;
export const SLOW_TEST = /e2e\/slow-[\w-]+\.test\.ts/g;
const EXTENSIONS =
  "ts|tsx|js|mjs|cjs|json|jsonc|md|mdx|yml|yaml|sh|swift|kt|kts|java|toml|txt|html|css|plist|py|xml|gradle";
export const PATH_LINE = new RegExp(
  `^(v\\d[\\w.-]*:)?([\\w@./-]*[\\w@-]\\.(?:${EXTENSIONS})):(\\d+)(?:-(\\d+))?$`,
);
export const PLAIN_PATH_LINE = new RegExp(
  `(?<![\\w/.@-])((?:[\\w@.-]+/)+[\\w@.-]+\\.(?:${EXTENSIONS})):(\\d+)(?:-(\\d+))?`,
  "g",
);
export const DOC_PATH = /\.(md|mdx)\b/;
export const CODE_PATH = new RegExp(`\\.(?!md\\b|mdx\\b)(?:${EXTENSIONS})\\b`);
export const STOP = new Set(
  "the a an and or of to in on at by for with from is are be it its as that this then than when one each no not into after before same their them they any all per but if so via while".split(
    " ",
  ),
);
