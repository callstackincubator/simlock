# Agent rules: coding

What an agent building or fixing a change needs from the delivery process.
Labels, claims, reviews and the merge gate are in
[delivery.md](delivery.md).

1. **The issue body is the spec.** Build what the body says, plus what
   [always-in-scope.md](always-in-scope.md) lists. Read the body, the
   documents it links, the latest `## Handoff` comment, and for a bug the
   triage report and any `## Decision` comment. Never the rest of the
   comment thread: a comment changes nothing until a spec session folds it
   into the body.
2. **A small gap is an assumption, not a stop.** A gap the body, the rules
   in this directory, the accepted ADRs and `always-in-scope.md` all leave
   open (a wording, an order, a bound the spec implies) is closed the
   conservative way and recorded as one `Assumption:` line under
   `## Assumptions` in the PR body. The spec review checks it and the
   maintainer may reject it; the body stays the spec. Stop for a person only
   when building would contradict the body, a rule or an accepted ADR, or
   would change behaviour a user sees in a way nobody decided.
3. **The branch is named from the issue, and only from the issue.** Work on
   issue `<n>` of kind `<kind>` happens on `<kind>/<n>` (`task/118`,
   `bug/79`, `feature/88`), and a bug's reproduction lives on
   `bug/<n>-repro`. No slug, no author prefix, no date. A PR from such a
   branch closes that issue and no other.
4. **Assume every agent is in a worktree.** Several agents share one clone
   through `git worktree`, so a branch may already be checked out somewhere
   else and `git switch` to it will fail. Create branches in whatever
   checkout you have, push them, and treat `origin/<branch>` as the truth;
   to continue a branch another checkout holds, branch from
   `origin/<branch>` rather than switching to it.
5. **The PR proves its Done when.** Every task PR walks its Done when lines,
   each with the hunk or test that delivers it; the PR that closes a
   feature's last open sub-issue also walks the parent's Completion
   conditions. A bug's triage test is its regression test and is in the PR.
