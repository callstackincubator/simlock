#!/usr/bin/env node
// `node .agents/scripts/claim.mjs <n> [--triage]`: claims issue <n> for this session's GitHub
// user, the one way an agent assigns an issue (delivery rule 2; the tool guard refuses `gh
// issue edit --add-assignee`). It refuses, exit 1 with one `claim: #<n> ...` line saying why, an
// issue that is closed, has an assignee, or carries no label an agent may act on (delivery rule
// 1): `bug:new` with `--triage` and only then, `bug:ready`, `task:ready`. A `task:ready` task
// also needs every issue its `## Depends on` names closed, or a sub-issue of the same feature
// whose PR (from `<kind>/<m>`) is open and not a draft. Then it assigns the user, and prints
// `claim: #<n> assigned to <login>`; when someone else got the issue at the same moment it
// unassigns the user again and refuses. The repo is GH_REPO, else the origin remote's owner/name.
import { execFileSync } from "node:child_process";

const [number] = process.argv.slice(2);
const triage = process.argv.includes("--triage");
if (!/^\d+$/.test(number ?? "")) {
  console.error("usage: claim.mjs <n> [--triage]");
  process.exit(64);
}
const nwo = repository();
const issue = api("GET", `issues/${number}`);
const labels = issue.labels.map((l) => (typeof l === "string" ? l : l.name));
const assignees = issue.assignees.map((a) => a.login);
if (issue.state !== "open") refuse("is closed");
if (assignees.length > 0) refuse(`is assigned to ${assignees.join(", ")}; it is theirs`);
const work = triage ? ["bug:new"] : ["bug:ready", "task:ready"];
const label = labels.find((l) => work.includes(l));
if (label === undefined) {
  refuse(
    `carries ${labels.filter((l) => /^\w+:/.test(l)).join(", ") || "no state label"}; ` +
      (triage
        ? "triage takes a bug:new issue"
        : "an agent acts on bug:ready and task:ready (with --triage, bug:new)"),
  );
}
if (label === "task:ready") {
  const depends =
    /^## Depends on\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(issue.body ?? "")?.[1] ?? "";
  const parent = parentOf(number);
  for (const dep of new Set([...depends.matchAll(/#(\d+)/g)].map((m) => m[1]))) {
    const other = api("GET", `issues/${dep}`);
    if (other.state === "closed") continue;
    const kind = other.labels
      .map((l) => (typeof l === "string" ? l : l.name))
      .find((l) => /^(task|bug):/.test(l))
      ?.split(":")[0];
    const sameFeature = parent !== null && parentOf(dep) === parent;
    const reviewed =
      kind !== undefined &&
      api("GET", `pulls?head=${nwo.split("/")[0]}:${kind}/${dep}&state=open`).some((p) => !p.draft);
    if (!sameFeature || !reviewed) {
      refuse(
        `depends on #${dep}, which is open${sameFeature ? " with no reviewed PR" : " and not a task of the same feature"} (delivery rule 1)`,
      );
    }
  }
}
const login = execFileSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8" }).trim();
const after = api("POST", `issues/${number}/assignees`, "-f", `assignees[]=${login}`);
const others = after.assignees.map((a) => a.login).filter((a) => a !== login);
if (others.length > 0) {
  api("DELETE", `issues/${number}/assignees`, "-f", `assignees[]=${login}`);
  refuse(`was claimed by ${others.join(", ")} at the same moment; it is theirs`);
}
if (!after.assignees.some((a) => a.login === login)) refuse(`could not be assigned to ${login}`);
console.log(`claim: #${number} assigned to ${login}`);

function parentOf(n) {
  try {
    return api("GET", `issues/${n}/parent`).number;
  } catch {
    return null;
  }
}

function api(method, at, ...extra) {
  return JSON.parse(
    execFileSync("gh", ["api", "-X", method, `repos/${nwo}/${at}`, ...extra], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function refuse(why) {
  console.error(`claim: #${number} ${why}. Not claimed.`);
  process.exit(1);
}

function repository() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const match = /([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  if (match === null) throw new Error(`Cannot read owner/name from origin ${url}; set GH_REPO`);
  return `${match[1]}/${match[2]}`;
}
