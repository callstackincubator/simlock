import { describe, expect, it } from "vitest";

// @ts-expect-error why: a plain script with no types
import { plan } from "../.agents/scripts/worktree-gc.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-25T12:00:00Z");

const merged = (hoursAgo: number) => ({
  number: 7,
  state: "closed",
  merged: true,
  closedAt: NOW - hoursAgo * HOUR,
});
const closed = { number: 8, state: "closed", merged: false, closedAt: NOW - 48 * HOUR };
const open = { number: 9, state: "open", merged: false, closedAt: null };

function worktree(path: string, extra: Record<string, unknown>) {
  return {
    path,
    branch: path,
    locked: false,
    dirty: false,
    lastActivity: NOW - 48 * HOUR,
    pr: null,
    inPr: false,
    inMain: false,
    ...extra,
  };
}

describe("worktree-gc.mjs", () => {
  it("removes a worktree only when it holds nothing a merged pull request or main lacks", () => {
    const decisions = plan(
      [
        worktree("merged", { pr: merged(2), inPr: true }),
        worktree("merged-just-now", { pr: merged(0.5), inPr: true }),
        worktree("merged-with-later-commits", { pr: merged(2), inPr: false }),
        worktree("merged-dirty", { pr: merged(2), inPr: true, dirty: true }),
        worktree("merged-locked", { pr: merged(2), inPr: true, locked: true }),
        worktree("open", { pr: open, inPr: true }),
        worktree("closed-unmerged", { pr: closed, inPr: true }),
        worktree("unpushed", {}),
        worktree("empty-branch", { inMain: true }),
        worktree("empty-branch-in-use", { inMain: true, lastActivity: NOW - 3 * HOUR }),
        worktree("lens", { branch: null }),
        worktree("lens-in-use", { branch: null, lastActivity: NOW - 23 * HOUR }),
      ],
      NOW,
    );

    expect(
      decisions.map((d: { path: string; action: string; reason: string }) => [
        d.path,
        d.action,
        d.reason,
      ]),
    ).toEqual([
      ["merged", "remove", "PR #7 merged"],
      ["merged-just-now", "keep", "PR #7 merged under an hour ago"],
      ["merged-with-later-commits", "keep", "commits PR #7 does not have"],
      ["merged-dirty", "keep", "uncommitted or untracked files"],
      ["merged-locked", "keep", "locked"],
      ["open", "keep", "PR #9 is open"],
      ["closed-unmerged", "keep", "PR #8 was closed without merging"],
      ["unpushed", "keep", "commits with no pull request"],
      ["empty-branch", "remove", "no commit of its own, idle 48 h"],
      ["empty-branch-in-use", "keep", "no commit of its own, used 3 h ago"],
      ["lens", "remove", "detached, idle 48 h"],
      ["lens-in-use", "keep", "detached, used 23 h ago"],
    ]);
  });
});
