// `node .agents/scripts/worktree-gc.mjs [--apply]`: removes the worktrees delivery left behind,
// so the disk the slow lane needs does not fill up with finished work.
//
// It looks only at the worktrees worktree.sh makes: the ones under
// <main checkout>/.claude/worktrees/, and the detached `wt-<commit>.*` folders of a review lens
// or a probe. The main checkout, the worktree it runs from, a locked worktree and any other
// tool's worktrees are never listed. A worktree goes when it holds nothing of its own:
//
//   - nothing uncommitted and nothing untracked, and
//   - a branch whose pull request merged at least an hour ago, with no commit the pull request
//     lacks; or a branch with no commit `origin/main` lacks, or a detached folder, idle for a day.
//
// Everything else is kept, with the reason. The branch itself is never deleted: a removed
// worktree comes back with `worktree.sh <branch>`.
//
// Without --apply it prints the plan and changes nothing. The first line is
// `worktree-gc: <n> worktrees, <r> to remove, <k> kept. Free: <g> GiB.`, then one
// `remove|keep <path> — <reason>` line each. With --apply it removes them, prunes, and ends
// `Removed <r>. Free: <g> GiB.`; a worktree git refuses to remove prints `failed <path> — <why>`
// and the script exits 1. The repo is GH_REPO, else the origin remote's owner/name.
import { execFile, execFileSync } from "node:child_process";
import { statSync, statfsSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { repository } from "./cli-args.mjs";

const HOUR = 60 * 60 * 1000;
const MERGED_FOR = HOUR;
const IDLE_FOR = 24 * HOUR;
const LENS_FOLDER = /^wt-[0-9a-f]{9}\./;

export function plan(worktrees, now) {
  return worktrees.map((w) => {
    const [action, reason] = decide(w, now);
    return { path: w.path, action, reason };
  });
}

function decide(w, now) {
  if (w.locked) return ["keep", "locked"];
  if (w.dirty) return ["keep", "uncommitted or untracked files"];
  if (w.pr?.state === "open") return ["keep", `PR #${w.pr.number} is open`];
  if (w.pr?.merged === true) return decideMerged(w, now);
  if (w.pr !== null && w.branch !== null && !w.inMain) {
    return ["keep", `PR #${w.pr.number} was closed without merging`];
  }
  return decideIdle(w, now);
}

function decideMerged(w, now) {
  if (!w.inPr) return ["keep", `commits PR #${w.pr.number} does not have`];
  if (now - w.pr.closedAt < MERGED_FOR)
    return ["keep", `PR #${w.pr.number} merged under an hour ago`];
  return ["remove", `PR #${w.pr.number} merged`];
}

function decideIdle(w, now) {
  const what = w.branch === null ? "detached" : "no commit of its own";
  if (w.branch !== null && !w.inMain) return ["keep", "commits with no pull request"];
  const idle = Math.floor((now - w.lastActivity) / HOUR);
  if (now - w.lastActivity < IDLE_FOR) return ["keep", `${what}, used ${idle} h ago`];
  return ["remove", `${what}, idle ${idle} h`];
}

const run = promisify(execFile);
const git = (cwd, ...args) => run("git", ["-C", cwd, ...args], { encoding: "utf8" });

async function succeeds(cwd, ...args) {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
}

function listed(porcelain) {
  return porcelain
    .split("\n\n")
    .filter((block) => block.startsWith("worktree "))
    .map((block) => {
      const lines = block.split("\n");
      const value = (key) =>
        lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
      return {
        path: value("worktree"),
        head: value("HEAD"),
        branch: value("branch")?.replace("refs/heads/", "") ?? null,
        locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      };
    });
}

function ours(w, mainRoot, here) {
  if (w.path === mainRoot || w.path === here) return false;
  if (w.path.startsWith(join(mainRoot, ".claude", "worktrees") + sep)) return true;
  return w.branch === null && LENS_FOLDER.test(basename(w.path));
}

async function pullRequest(repo, branch) {
  const owner = repo.split("/")[0];
  const { stdout } = await run(
    "gh",
    ["api", "-X", "GET", `repos/${repo}/pulls`, "-f", `head=${owner}:${branch}`, "-f", "state=all"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const pulls = JSON.parse(stdout);
  const pull = pulls.find((p) => p.state === "open") ?? pulls[0];
  if (pull === undefined) return null;
  return {
    number: pull.number,
    state: pull.state,
    merged: pull.merged_at !== null,
    closedAt: pull.closed_at === null ? null : Date.parse(pull.closed_at),
    head: pull.head.sha,
  };
}

async function inspect(w, repo) {
  const { stdout: status } = await git(w.path, "--no-optional-locks", "status", "--porcelain");
  const { stdout: gitDir } = await git(w.path, "rev-parse", "--absolute-git-dir");
  const pr = w.branch === null ? null : await pullRequest(repo, w.branch);
  return {
    ...w,
    dirty: status.trim() !== "",
    // why: the HEAD log is written by a checkout, a commit and a merge, and by nothing that only reads.
    lastActivity: mtime(join(gitDir.trim(), "logs", "HEAD")) ?? mtime(w.path) ?? 0,
    pr,
    inPr: pr !== null && (await succeeds(w.path, "merge-base", "--is-ancestor", "HEAD", pr.head)),
    inMain: await succeeds(w.path, "merge-base", "--is-ancestor", "HEAD", "origin/main"),
  };
}

function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

async function inBatches(items, size, work) {
  const results = [];
  for (let at = 0; at < items.length; at += size) {
    results.push(...(await Promise.all(items.slice(at, at + size).map(work))));
  }
  return results;
}

function freeGiB(path) {
  const { bavail, bsize } = statfsSync(path);
  return ((bavail * bsize) / 2 ** 30).toFixed(1);
}

function removeAll(mainRoot, removals) {
  let failed = 0;
  for (const { path } of removals) {
    try {
      execFileSync("git", ["-C", mainRoot, "worktree", "remove", path], { stdio: "pipe" });
    } catch (error) {
      failed += 1;
      console.log(
        `failed ${path} — ${
          String(error.stderr ?? error.message)
            .trim()
            .split("\n")[0]
        }`,
      );
    }
  }
  execFileSync("git", ["-C", mainRoot, "worktree", "prune"]);
  return failed;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const here = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  const mainRoot = dirname(common);
  const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  const candidates = listed(porcelain).filter((w) => ours(w, mainRoot, here));
  const repo = repository();
  const decisions = plan(await inBatches(candidates, 8, (w) => inspect(w, repo)), Date.now());
  const removals = decisions.filter((d) => d.action === "remove");
  console.log(
    `worktree-gc: ${decisions.length} worktrees, ${removals.length} to remove, ` +
      `${decisions.length - removals.length} kept. Free: ${freeGiB(mainRoot)} GiB.`,
  );
  for (const d of decisions) console.log(`${d.action} ${d.path} — ${d.reason}`);
  if (!apply) return;
  const failed = removeAll(mainRoot, removals);
  console.log(`Removed ${removals.length - failed}. Free: ${freeGiB(mainRoot)} GiB.`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
