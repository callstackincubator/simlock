# Rules agents must remember that a check could enforce

Scouted 2026-10-25 on `chore/audit-delivery-process` (working tree, with its uncommitted edits to the briefs, `tool-guard.mjs`, `ci-triage.mjs`, and the untracked `issue-body.mjs`, `review-ledger.mjs`, `pr-shas.sh`). Read: every file in `docs/internal/agent-rules/`, `REVIEW.md`, `templates/*.md`, `.agents/briefs/*.md`, `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`. Also read, to know what is already enforced: `lefthook.yml`, `.claude/settings.json`, every `.agents/scripts/*` header, `.github/workflows/{issue-state,ci}.yml`, `.dependency-cruiser.mjs`, `.oxlintrc.json`, and the repo-invariant tests in `src/*.test.ts`. I measured baselines with greps on the tree and on eight live task bodies (#917 to #919, #956 to #959, #966) and three feature bodies (#905, #952, #961).

Effort: S is under an hour (one regex or one test). M is about half a day (a script with cases). L is a day or more. Confidence says how well the check matches what the rule means. Value is my guess at defects or agent-minutes saved per month.

## Verdicts (maintainer review, 2026-10-25)

Each item below is **apply** (in the next PRs, grouped as listed), **later** (right, not now) or **ignore** (with the reason). The eight drifts are fixed in the first conversion PR.

| Verdict | Items | Reason |
| --- | --- | --- |
| apply, PR A: tests and catalogs, plus the drift fixes | R1, R13, R14, R15, R16, R17, R18, R19, R20, R22, R25, R30, R38, R45 | Repo tests and a diff-scoped `test-lint.mjs`. Five of them fail on real drift today; R13, R15, R38 and R45 are review-finding classes from the ledgers (time bounds, vacuous assertions, internal-file imports, unbounded wire fields) that build agents do not read the rule for. R30 widens an existing depcruise rule and needs a known-violations list that only shrinks. |
| apply, PR B: guards and PR checks | R3, R4, R5, R7, R8, R9, R10 (sub-agents only), R11, R12, R23, R24, R27, R28, R35, R39, R41, R42, R47 (the merge check only), R48, R2 | One regex or one function each in `tool-guard.mjs`, `report-guard.mjs`, `pr-body-check.mjs`, `issue-state.yml` or a `commit-msg` hook. R5 and R8 close silent holes (a slugged branch skips every delivery check; a `+refspec` force push is allowed). R4 makes the gate read what rule 15 says it "cannot read". R2 is the only M-sized one and the one most often broken (the footer and budgets on comments). |
| apply, PR C: the spec lint | R31, R32, R33, R34, R43 | `spec-lint.mjs` takes the structural half of the checker's categories before an Opus checker starts, with `runnable.mjs` replacing the orchestrator's hand check of Depends on, and the `chain` and `depends-outside` findings the process review asked for. R43 adds the website trailer check and the config-keys catalog test. Checker rounds are half a spec session; this is where the minutes are. |
| later | R29, R36, R37, R40, R46 | R36 needs a findings-schema field (severity) first; R37 would fight legitimate tables and the red-green record already serves the intent; R40 depends on SubagentStop firing for nested lenses (verify, then do); R29 is an input the spec lens can count itself; R46 needs the TS API for a rule that only applies when an index grows. |
| ignore | R21, R44, R49, R50 | R21 has no value (casing never drifted); R44 is covered by R25's test on every commit; R49 costs CI minutes for noise the weekly mutation run already produces; R50 is an AST comparison for a judgement call (one claim, one level). |
| ignore, R10's main-session half | — | The maintainer asks this session to set labels by hand; an `ask` rule would only add prompts. The sub-agent half stays. |

## Drift the scout found (a check would have caught each)

- **`SERVICE_FAILED` is missing from `website/src/content/docs/docs/reference/errors.mdx`.** The exit-code table lists 55 of `ERROR_TABLE`'s 56 codes. The code is only on `using-devices/errors.mdx:78`. See R17.
- **`docs/internal/VENDORED-CODE.md:17` names `vendor/agent-device-proxy-0.21.28-dev-253dca0.tgz`.** That file does not exist. `package.json` now takes `@agent-device/proxy` `0.21.28` from npm (#603). See R25.
- **Three unit tests assert a real-time bound outside a `*.timing.test.ts` file.** They are `src/agent-device/host/agent-device-supervisor.test.ts:511`, `src/agent-device/host/health.test.ts:62` and `src/daemon/dispatcher.test.ts:3893`. Testing rule 5 forbids it. See R13.
- **Three manuals name private members.** `src/gateway/AGENTS.md:104` (`#fleetLeases()`), `src/history/AGENTS.md:25` (`#start`) and `src/leasing/AGENTS.md:30` (`#refuseUnderHold`). The manual template forbids it. See R19.
- **A slugged branch escapes every delivery check.** The `branch-matches-issue` job (`issue-state.yml:291`) and `pr-body-check.mjs` match only `^(bug|feature|task)/\d+$`. So `task/118-foo` skips the Closes check, the Status and Assumptions checks, and the ledger check, all in silence. See R5.
- **`git push origin +task/1` (a force push by refspec) is not denied.** `settings.json` denies `--force` and `-f` only. Nothing guards `git stash` or `git rebase` either. See R8.
- **The tool guard has a false positive.** `ls .dependency-cruiser* vitest*` was refused as "a test run needs `timeout: 600000`", because `TEST_RUNNER` matches the bare word `vitest` anywhere in the command. The fix is to match it only in command position, the way `forbiddenCheck` already splits segments.
- **`bus/index.test.ts:276` checks the event names against `docs/internal/EVENTS.md` only.** The website catalog has the same row format and the same 53 names today, but nothing checks it. See R1.

## Summary table

Sorted by effort, then by value. "Where" names the place the check runs.

| # | Rule | Check | Where | Effort | Conf. |
|---|---|---|---|---|---|
| R1 | events 8, always-in-scope 3: both catalogs | website `events.mdx` names == `EVENT_NAMES` | `src/bus/index.test.ts` (one path added to the `it.each`) | S | high |
| R4 | delivery 15: no blocking finding open, assessment complete | ledger JSON has no `outcome: open`; `## Review` holds `Assessment: complete` | `pr-body-check.mjs` (so `merge-pr.sh` too) | S | high |
| R13 | testing 5: no real-time bound outside timing files | added `expect(` on `Date.now()`/`performance.now()`/`hrtime` in a non-timing test | new `test-lint.mjs`, diff-scoped, in the commit hook and CI | S | high |
| R14 | testing 5: never skip or disable a test | added `.only`, `.skip`, `.todo`, `skipIf` in a test file | `test-lint.mjs` (or the oxlint vitest plugin) | S | high (`.only`), medium (`.skip`) |
| R15 | testing 10: assertions a failure also satisfies | added `toBeInstanceOf(Error)`, `?.(` inside `expect`, `not.toBe("pending")` | `test-lint.mjs` | S | medium-high |
| R3 | toolchain "Review measurement"; deliver "Delegating" | Agent prompt line 1 is the ledger tag; implementer prompt holds `brief:` + the file text; reviewer holds `protocol:` + REVIEW.md | `tool-guard.mjs` (Agent branch) | S | high |
| R5 | coding 3: branch from the issue only | a `bug|task|feature/` head must be exactly `<kind>/<n>`, `bug/<n>-repro` or `feature/<n>-adr*`; a PR closing a task or bug must come from `<kind>/<n>` | `issue-state.yml` branch job | S | high |
| R7 | build brief: commit shapes | on `<kind>/<n>`: subject is `<type>(<scope>)?: … (#<n>)`; merges exempt | lefthook `commit-msg` | S | high |
| R8 | implementer 6; delivery 15; fix brief | sub-agents: no `git stash`, `git rebase`, or `git push … +ref` | `tool-guard.mjs` | S | high |
| R9 | delivery 14; implementer "do not mark ready"; delivery 8 | sub-agent `gh pr create` needs `--draft`; no `gh pr ready` in sub-agents; no PR from `*-repro` | `tool-guard.mjs` | S | high |
| R10 | delivery 1 "agents never label their way into work" | refuse `--add-label bug:ready` for every agent; `task:ready`, `feature:planned` from sub-agents | `tool-guard.mjs` | S | high |
| R11 | delivery 16; triager, code lens: never the slow lane | vitest naming `e2e/slow-*` or `--project e2e` without `!slow`; `slow-e2e.sh` only for hardware-verifier and implementer | `tool-guard.mjs` (by `agent_type`) | S | high |
| R12 | implementer "helpers run in the foreground"; deliver "never pass a model" | sub-agent Agent call with `run_in_background: true`; `model` on implementer, reviewer or hardware-verifier | `tool-guard.mjs` | S | high |
| R17 | documentation 9: errors reference | every `ERROR_TABLE` code sits in `reference/errors.mdx`, in the row of its `cliExitCode` | new test in `src/contract/` | S | high |
| R25 | vendor 11: inventory true | every `vendor/` first-level entry has a VENDORED-CODE row and a `vendor/README.md` entry; every "Where it lives" path exists | `src/source-hygiene.test.ts` | S | high |
| R16 | documentation 3, always-in-scope 2: printed text names no repo path | no string literal in non-test `src/`, `ui/src/` names `docs/internal`, `agent-rules`, `AGENTS.md`, `CLAUDE.md` or a repo `.md` path | repo test | S | high |
| R23 | coding 2; delivery 12 "cut before posted, not excused after" | `## Assumptions` is `none` or only `- Assumption: … — …` lines; the 200-word budget fails instead of warning | `pr-body-check.mjs` | S | high |
| R24 | build brief `remaining`; audit "Promised" | `cycles b/t` with b<t needs t-b `remaining` lines or a `spec needs`; `donewhen k/n` with k<n needs `open` lines; `Rerun` in its enum; `Findings file` exists | `report-guard.mjs` | S | high |
| R28 | routine skills: "only test files", "comments only", calibration only | `chore/garden-comments-*` is `comments-only`; `chore/(audit|harden)-tests-*` is `tests-only`; `chore/calibrate-reviews-*` touches only `calibration.md` | `pr-body-check.mjs` via `diff-kind.mjs` | S | high |
| R19 | documentation 7, manual template | no `` `#private` ``; `Does:`, `Entry:`, `Uses:` present; no empty section | `src/docs-manuals.test.ts` | S | high |
| R20 | delivery 10; fix brief `adr:` flip | README Status column == the ADR's `**Status:**` line | `src/adr-index.test.ts` | S | high |
| R18 | documentation 9: CLI reference | every command name in `src/cli/tree.ts` appears in `reference/cli.mdx` | repo test | S | medium |
| R22 | events 1: `subject.past-tense-fact` | every `EventName` matches `^[a-z][a-z-]*\.[a-z][a-z-]*$`; its last word ends in `ed` or is on a short allow-list | `src/bus/index.test.ts` | S | medium |
| R27 | fix brief: `adr:` fix "change nothing else" | the commit touches only `**Status:**` lines and README index rows | script the coordinator calls | S | high |
| R21 | documentation 5: casing | top-level `docs/internal/*.md` UPPER; `adr/`, `agent-rules/`, `flows/`, website lower | repo test | S | high (low value) |
| R29 | spec review Q3, testing 7 | `tests-count.txt` in the review inputs: new test blocks against Tests lines | `review-inputs.sh` (an input, not a gate) | S | medium |
| R30 | architecture 9, always-in-scope 7: ports | `no-fs-or-process` for all of `src/` but `ports/`; no `Date.now()`, bare `new Date()`, `setTimeout`, `setInterval` outside `src/ports/` | `.dependency-cruiser.mjs` + grep test with known list | S-M | high |
| R31 | spec templates; delivery 7; spec-checker structural categories | `spec-lint.mjs <issue>`: sections, placeholders, footer, Tests count, hardware lines, contract bump wording, and more (see below) | spec-session before the checker; `issue-state` on `labeled task:ready`; deliver step 1 | M | high |
| R32 | task template Facts; spec-checker `fact` | every `path:line` in the body resolves at the body's `Commit <sha>`; Source never docs-only, "memory", "to re-check" or empty | `spec-lint.mjs` | M | high (existence), not truth |
| R33 | delivery 1; proposals 6 and 7 of the 2026-10-25 review | Depends on: exists, no cycle, open issue of another feature means `depends-outside`, chain length printed; `runnable.mjs <feature>` | `spec-lint.mjs` feature scope; deliver step 3 | M | high |
| R34 | feature template Behaviours; spec-checker `untested` | per task: Behaviours rows naming it == bullets under `### Tests`; every row's Task is a sub-issue | `spec-lint.mjs` feature scope | M | medium-high |
| R2 | delivery 2, 8, 12; deliver step 5; spec-session | body guard: footer on every agent-written body and comment; Handoff with 4 sections ≤150 words; triage sections ≤300 words, ≤3 alternatives, ≤3 risks; "Spec updated" one line | `tool-guard.mjs` on `gh issue|pr comment|create|edit` and `gh api … body=@` | M | high |
| R35 | coding 5; deliver step 4; audit "Promised" | every issue `## Done when` bullet is a checklist line in the PR body; ready PR has all `[x]`; last sub-issue PR lists the parent's Completion conditions | `pr-body-check.mjs` | M | high (presence), not truth |
| R36 | deliver step 4; REVIEW "Measurement" | the `## Review` counts line is generated from the findings file; `pr-body-check` cross-checks it | `review-ledger.mjs` + `pr-body-check.mjs` | M | high |
| R37 | build brief "one test per commit" | each `test:` commit on `<kind>/<n>` adds at most one new `it(`/`test(`/`it.each(` call site | lefthook `pre-push` | M | high (count) |
| R38 | testing 6; audit brief | a test that adds an import of a sibling internal file (component dir, not `index`, `testing` or `test-*`) has `why:` in the 3 lines above its first `describe(` | `test-lint.mjs`, diff-scoped | M | high (shape) |
| R39 | REVIEW "Routing"/"Select lenses" | `skipped` reviews match the `diff-kind.mjs` kind of merge-base..head | `pr-body-check.mjs` | M | medium-high |
| R40 | review briefs "Output" | lens output: list lines, `F<n> B|N path:line … [class] ev: …` or `F0`, last line `Assessment:`, ≤400 words, ≤2 notes; code lens leaves its worktree clean | `report-guard.mjs` for the three lens agents | M | high |
| R41 | delivery 1, 2; triager step 1 | `claim.mjs <n>`: assign only when unassigned and the label allows it; the guard refuses a raw `--add-assignee` | script + `tool-guard.mjs` | M | high |
| R42 | delivery 14, REVIEW cap | ledger `Round` lines: full SHAs, ancestors of head, at most one `1` and one `2`; at most one `## Review notes` comment | `pr-body-check.mjs` | M | medium |
| R43 | documentation 9 public surface | diff touches `tree.ts`, config defaults or validator, `ERROR_TABLE`, MCP tools, HTTP routes, client/admin index, `EventName` → diff touches `website/src/content/docs/`, or a `Docs: none (<reason>)` trailer; plus a config-keys catalog test | CI job (like protocol-bump) + repo test | M | medium (diff rule), high (catalog) |
| R44 | vendor 11 | diff adds, removes or renames a file under `vendor/<dir>/` or edits `SHA256SUMS.txt` → diff touches its `NOTICE.md`, `VENDORED-CODE.md` and `vendor/README.md` | CI job | M | medium |
| R45 | always-in-scope 8, safety 10 | an added `z.string()`, `z.array(` or `z.record(` in `src/contract/*.ts` without `.max`, `.length`, `.regex` or a bounded helper | `test-lint`-style diff lint | M | medium |
| R46 | architecture 18 | an `index.ts` the diff grows exports no class | diff lint with the TS API | M | medium |
| R47 | delivery 10 | at stack merge every ADR in the stack's diff says `Accepted`; weekly: an ADR at "not yet implemented" has an open feature linking it | `merge-pr.sh`; weekly routine | M | medium |
| R48 | REVIEW "Routing" | a code-reviewer Agent call with `model` other than opus while `<inputs>/diff.patch` touches strict-area paths | `tool-guard.mjs` | M | medium |
| R49 | testing 3 (strict areas), audit "Covered" | mutation on strict-area changed lines per PR; survivors annotate or fail | CI job | L | medium |
| R50 | testing 1, 7: cases as one table | sibling `it()` bodies in the diff with the same token shape apart from literals | diff lint, AST | L | medium |

## Top five by value for effort

1. **`test-lint.mjs` (R13, R14, R15, R38).** One diff-scoped script, built like `comment-lint.mjs`, run in the commit hook and in CI. It enforces the testing rules that build agents do not read (`testing.md` was opened 3 times in 29 runs). The time-bound and skip lints are about an hour each. Three real violations exist today. Diff-scoped, it needs no allow-list.
2. **The gate reads the ledger (R4).** `merge-pr.sh` says the agent "also checks what the script cannot read". The ledger comment now carries that data: a finding with `outcome: open`, and the Assessment line. Adding them is a few lines in `pr-body-check.mjs`, and it removes an unchecked step before merge.
3. **`spec-lint.mjs` before the Opus checker (R31 to R34).** The live bodies are regular enough to parse: the same 13 headings in all eight tasks, Facts tables with path:line sources and a `Commit <sha>.` line. About half of the checker's categories have a structural part. The Facts-resolve check (R32) and the Depends-on chain (R33) are the parts with most value. Checker rounds are half of a spec session today (process review S1).
4. **The body and comment guard (R2).** One PreToolUse rule covers the footer on every comment and body, the Handoff shape and budget, the triage-report shape and budget, the one-line "Spec updated" comment, and the Review notes shape. Today none of these is checked; only the PR body is.
5. **Catalog tests for the public surface (R1, R17, R25).** Each is under an hour, and R17 and R25 fail today on real drift. R1 is adding one path to an existing `it.each`.

Close behind: the branch and commit shape checks (R5 and R7, which close the slugged-branch hole), and the tool-guard additions (R8 to R12, each a regex with tests).

## Per-item detail

The format for each item: rule, then the check (inputs and pass/fail condition), then false-positive risk, then an example that fails and one that passes, then the residual left to judgement.

### S items

**R1. Website event catalog.**
- **Rule:** always-in-scope 3, "A new or changed event updates the website's events reference … and `docs/internal/EVENTS.md`"; events 8; documentation 4.
- **Check:** in `src/bus/index.test.ts`, change `it.each(["docs/internal/EVENTS.md"])` (lines 276 and 282) to also take `"website/src/content/docs/docs/reference/events.mdx"`. `documentedEventNames` already parses that row shape. Both files hold the same 53 names today.
- **FP risk:** none. **Fail:** a new `EventName` with a row in EVENTS.md only. **Pass:** a row in both.
- **Residual:** that the payload columns agree. A second step could compare the payload field list per row.

**R3. Prompt shape for stage and lens agents.**
- **Rule:** toolchain "Review measurement", "Every prompt a delivery stage or review lens is started with begins with this line". Deliver, "the full text of `.agents/briefs/implement-<mode>.md`" under `brief:`, and REVIEW.md under `protocol:`. Reviewer step 2 pastes each lens brief.
- **Check:** in the `tool-guard.mjs` Agent branch, when `subagent_type` is implementer, reviewer, hardware-verifier, spec-reviewer, code-reviewer or claims-reviewer:
  - the prompt's first line matches `^ledger: (?=.*\bpr=\S+)(?=.*\bstage=(build|audit|fix|hardware-fix|review|hardware|replay)\b)(?=.*\brole=\S+)`;
  - for an implementer, the prompt contains `brief:`, and the text after it contains the first 200 characters of `.agents/briefs/implement-<mode>.md`, with `<mode>` read from the prompt's `mode:` line;
  - for a reviewer, it contains `protocol:` and REVIEW.md's first heading line.
- **FP risk:** the `implement` and `review` skills started by a person also go through here, but they already require the tag. **Fail:** `issue: 966\nmode: build`. **Pass:** `ledger: pr=- issue=966 stage=build round=- role=implementer lens=-\nissue: 966 …\nbrief:\n# Mode \`build\`…`.
- **Residual:** none for the shape. This is what makes "the rules reach the agent" mechanical, given that the agents do not open the rule files themselves.

**R4. The gate reads the ledger.**
- **Rule:** delivery 15, "Before calling it the agent also checks what the script cannot read: no blocking finding is open and assessment is complete". REVIEW, "no incomplete assessment may be marked ready or merged".
- **Check:** in `pr-body-check.mjs`, when not `--draft-ok` and on a `<kind>/<n>` branch:
  - parse the json code block of the `## Review ledger` comment (the comments are already fetched for the ledger-exists check). Fail on any finding whose `outcome` is `open`;
  - fail when the `## Review` section has no line `^Assessment: complete\b`. Today it fails only on `incomplete`.
- **FP risk:** routine PRs have no ledger; keep the `<kind>/<n>` scope. **Fail:** a ledger with `{"id":"R2","outcome":"open",…}`. **Pass:** every outcome is `fixed` or another closed state, and the line `Assessment: complete` is present.
- **Residual:** whether a `nonblocking` disposition was right.

**R5. Branch name strictness.**
- **Rule:** coding 3, "Work on issue `<n>` of kind `<kind>` happens on `<kind>/<n>` … No slug, no author prefix, no date. A PR from such a branch closes that issue and no other".
- **Check:** in the `branch-matches-issue` job, when the head starts with `(bug|feature|task)/` but does not match `^(bug|task|feature)/\d+$`, fail. The exceptions are `^feature/\d+-adr[\w-]*$` (ADR PRs, which have their own rule) and nothing else: `bug/<n>-repro` must never have a PR (R9). Second, when the body closes an issue labelled `task:*` or `bug:*`, the head must be `<kind>/<n>` with that kind and number. That needs one `issues.get` call.
- **FP risk:** maintainer chore branches do not start with a kind prefix, so they are unaffected. **Fail:** `task/118-fix-queue` and `Closes #118`. **Pass:** `task/118`.

**R7. Commit message shape.**
- **Rule:** build brief, `git commit -m "test: <the line's claim> (#<N>)"`, and `<type>(<scope>): <what now works> (#<N>)`. Triager, `test: reproduce #<N> — <claim>`.
- **Check:** a lefthook `commit-msg` step `node .agents/scripts/commit-msg-check.mjs {1}`. With the branch from `git branch --show-current`:
  - on `^(bug|task|feature)/(\d+)$`: the subject matches `^(feat|fix|test|docs|chore|refactor|perf|build|ci)(\([\w./-]+\))?: .+ \(#\2\)$`, or the parent feature's number for ADR commits on a stacked branch (allow any `(#\d+)`, warn on a mismatch);
  - on `bug/<n>-repro`: `^test: reproduce #<n> — .+`.
  - Merge commits (`Merge `) are exempt.
- **FP risk:** low. All 34 subjects on `origin/task/968` conform. **Fail:** `wip`. **Pass:** `test: a new simulator's marks name this instance (#968)`.

**R8. Git commands sub-agents never run.**
- **Rule:** implementer checklist 6 "Never `git stash`"; build brief "all worktrees share one stash list"; fix brief "Never rebase, never force-push"; delivery 15 "a rebase a force push nobody may make".
- **Check:** in `tool-guard.mjs`, for a sub-agent, refuse a segment starting `git stash` (any form), `git rebase`, or `git push` with an argument matching `^\+` or `:\S+` (a refspec force or a remote delete). This uses the existing `forbiddenCheck` segment split.
- **FP risk:** `git rebase --abort` after a person's own rebase. Not a delivery case. **Fail:** `git stash push -u`. **Pass:** `git commit -m …`.

**R9. Draft, ready and repro PRs.**
- **Rule:** delivery 14, "Every PR starts in draft". Implementer, "Do not claim, review, mark ready or merge". Delivery 8, the repro branch "opens no pull request".
- **Check:** in `tool-guard.mjs`, for a sub-agent:
  - `gh pr create` without `--draft`: refuse;
  - `gh pr ready`: refuse;
  - `gh pr create` whose `--head` or current branch ends in `-repro`: refuse;
  - the REST form `gh api … /pulls -F draft=` must carry `draft=true`.
- **FP risk:** routines run in the main session, so they are not affected. **Fail:** `gh pr create --title …` from the implementer. **Pass:** the same with `--draft`.

**R10. Labels into work.**
- **Rule:** delivery 1, "Agents never label their way into work"; "only the maintainer moves a bug to `bug:ready`". Deliver step 1, "Never add `bug:ready`".
- **Check:** in `tool-guard.mjs`:
  - any session (Claude is the actor): refuse `gh issue edit … --add-label bug:ready` and the REST form `labels[]=bug:ready`;
  - sub-agents also may not add `task:ready` or `feature:planned`, which only the spec-session main session sets.
- **FP risk:** the maintainer asking Claude to do it by hand. Make it an `ask` rule in `settings.json` instead of a deny, for the main session. **Fail:** a triager adding `bug:ready`. **Pass:** `--add-label bug:needs-info --remove-label bug:new`.

**R11. No slow lane outside its script and its agents.**
- **Rule:** delivery 16, "Agents run it only through the script". Triager, "Never run the slow lane". Code review, "never the slow lane". Implementer checklist 6.
- **Check:** in `tool-guard.mjs`:
  - any agent: refuse `vitest` with an `e2e/slow-*.test.ts` operand, or with `--project e2e` and no `--tags-filter` excluding `slow`. Only `pnpm test:e2e:slow` is on `ask` today; `pnpm exec vitest run --project e2e e2e/slow-ios.test.ts` bypasses both the lock and the ask.
  - `slow-e2e.sh` (other than `status`) when `agent_type` is neither hardware-verifier nor implementer. The hook input carries `agent_type`, as `tool-guard.test.ts:24` shows.
- **FP risk:** the implementer's non-hardware modes can still run it. Narrowing that needs the mode, read from the transcript's first user message. **Fail:** a bug-triager running `scripts/slow-e2e.sh e2e/slow-ios.test.ts`. **Pass:** a hardware-verifier running the same.

**R12. Helpers in the foreground; no model on stage agents.**
- **Rule:** implementer, "Helpers run in the foreground … each an Agent call with `run_in_background: false`". Deliver, "Never pass a model or `isolation`".
- **Check:** in `tool-guard.mjs`, refuse an Agent call from a sub-agent with `run_in_background` not equal to `false`. In any session, refuse `model` on `subagent_type` implementer, reviewer or hardware-verifier. Lens model overrides are the reviewer's job, so leave lenses free.
- **FP risk:** `spec-session` starts background explorers, but it is the main session, so it is not affected. **Fail:** the implementer starting an Explore helper in the background. **Pass:** the same with `run_in_background: false`.

**R13. Real-time bounds in unit tests.**
- **Rule:** testing 5, "A bound on real time belongs in a `*.timing.test.ts` file or the slow lane, never in a unit or e2e assertion". Build brief says the same.
- **Check:** `test-lint.mjs`, which reuses the `comments.mjs` machinery for added lines. For files matching `\.test\.tsx?$`, not `\.timing\.test\.ts$` and not `^e2e/slow-`, an added line fails when it matches `expect\([^;]*\b(Date\.now|performance\.now|process\.hrtime)\b`. It also fails on `expect\((\w+)\)\.toBe(Less|Greater)Than` where `\1` was assigned from those calls in the same test. Run it in the commit hook (`{staged_files}`) and in CI against `origin/<base>`.
- **FP risk:** a `Date.now()` used to build fixture data, not a bound. The rule only fires inside `expect(`. **Fail:** `expect(Date.now() - started).toBeLessThan(2_000)`, as in `health.test.ts:62`. **Pass:** the same line in `health.timing.test.ts`, or `clock.advance(2_000)` with an exact assertion.
- **Residual:** bounds hidden in helpers. **Baseline:** 3, all left alone because the lint is diff-scoped.

**R14. Focused and skipped tests.**
- **Rule:** testing 5, "Never skip, disable, or quarantine a test to get to green".
- **Check:** in `test-lint.mjs`, an added line matching `\b(it|test|describe)\.(only|skip|todo)\b`, or a `skipIf(`/`runIf(` with no `SIMLOCK_` environment gate on the same line. Alternatively, enable oxlint's `vitest` plugin with `no-focused-tests` and `no-disabled-tests` set to error.
- **FP risk:** the live-device gates (`process.env.SIMLOCK_LIVE_ANDROID === "1" ? it : it.skip`, `android/index.test.ts:4842`), which is why the environment exemption exists. **Fail:** `it.skip("grants …")`. **Pass:** `const live = process.env.SIMLOCK_LIVE_X === "1" ? it : it.skip`.
- **Baseline:** 30 matches tree-wide, most of them in `expected-failures.test.ts` fixtures.

**R15. Assertions a failure also satisfies.**
- **Rule:** testing 10, "`not.toBe(pending)` passes on a rejection; `toBeInstanceOf(Error)` passes on a `TypeError`; `x?.()` passes when nothing was recorded".
- **Check:** in `test-lint.mjs`, added lines in test files matching `toBeInstanceOf\(Error\)`, `\.not\.toBe\(\s*["']pending`, or `\?\.\(` inside an `expect(…)` or in the statement right after an `await`.
- **FP risk:** `?.(` in setup code, so restrict it to `expect` arguments. **Fail:** `expect(failure).toBeInstanceOf(Error)`, as in `optional-modules.test.ts:461`. **Pass:** `expect(failure).toMatchObject({ code: "PROVISION_FAILED" })`.
- **Baseline:** 15 `toBeInstanceOf(Error)` tree-wide.

**R16. Printed text names no repo path.**
- **Rule:** documentation 3, "Nothing the running tool prints or returns ever names a file path in this repository". Always-in-scope 2.
- **Check:** a repo test that walks `git ls-files 'src/*.ts' 'ui/src/*.ts*'` minus test, `testing.ts` and `test-*` files. Every string literal must not match `docs/internal|agent-rules|\bAGENTS\.md|\bCLAUDE\.md|\b(src|docs|e2e|scripts)/[\w/.-]+\.(md|ts)`.
- **FP risk:** `SKILL.md` (`src/instructions/setup.ts:32`) is a file the tool writes, not a repo doc, so allow it. **Fail:** `throw usage("see docs/internal/EVENTS.md")`. **Pass:** `"… https://callstackincubator.github.io/simlock/docs/reference/events/"`.
- **Baseline:** 0 hits.

**R17. Error codes in the reference.**
- **Rule:** documentation 9, "HTTP routes, bodies and error codes … updates every website page that describes it — … the reference table that lists it".
- **Check:** a test in `src/contract/` that imports `ERROR_TABLE` and parses the `## Exit codes` table of `website/src/content/docs/docs/reference/errors.mdx`. Each code must sit in exactly one row, and that row's Exit cell must equal `cliExitCode`.
- **Fails today:** `SERVICE_FAILED` (`errors.ts:419`, exit 1) is in no row. **Pass:** `INTERNAL` in the `| 1 |` row.

**R18. CLI commands in the reference.**
- **Rule:** documentation 9.
- **Check:** every `name: "<cmd>"` in `src/cli/tree.ts` occurs in `reference/cli.mdx`, as a heading or as `` `<cmd>` ``. Passes today.
- **FP risk:** hidden or internal commands, which need an exclusion list.
- **Residual:** whether each flag is described. A later step could compare flags per command from the tree.

**R19. Manual shape.**
- **Rule:** manual template, "Name files and exported names, never private members (`#field`)"; "Drop a section that would be empty"; `Does`, `Entry`, `Uses` lines. Documentation 7.
- **Check:** in `src/docs-manuals.test.ts`:
  - no `` `#[A-Za-z]\w*` `` token in a manual or flow doc;
  - lines `^Does: `, `^Entry: `, `^Uses: ` present in each `src/**/AGENTS.md`;
  - no `## ` heading followed by another heading with nothing in between.
- **Fails today:** the three private-member mentions. The other parts pass.

**R20. ADR index status.**
- **Rule:** delivery 10; fix brief, "set that ADR's `**Status:**` line and its row in `docs/internal/adr/README.md`".
- **Check:** in `src/adr-index.test.ts`, compare each row's Status cell, up to the first `;` or `(`, with the ADR file's `- **Status:**` line, also cut at the first `;` or `(`. They match today (0 mismatches in a scratch check).
- **Fail:** the file says Accepted and the row says Accepted — not yet implemented.

**R21. Doc file casing.**
- **Rule:** documentation 5.
- **Check:** a repo test: files directly under `docs/internal/` match `^[A-Z0-9-]+\.md$`; `adr/`, `agent-rules/` and `flows/` match `^[a-z0-9-]+\.md$` (plus `README.md`); `website/src/content/docs/**/*.mdx` are lower-case. Passes today.

**R22. Event name shape.**
- **Rule:** events 1, "Names are `subject.past-tense-fact`, lowercase, dot-separated".
- **Check:** every key of `EVENT_NAMES` (`src/bus/index.test.ts:12`) matches `^[a-z][a-z-]*\.[a-z][a-z-]*$`, and its last hyphen word ends in `ed`. A short allow-list covers the exceptions there today (`ready`, `stopping`, `shutdown`).
- **Residual:** "facts, never commands" (events 2) is judgement once the word is allowed.

**R23. Assumptions and the PR body budget.**
- **Rule:** coding 2, "recorded as one `Assumption:` line under `## Assumptions`". Implementer, `- Assumption: <q> — <choice>`. Delivery 12, "Text over budget is cut before it is posted, not excused after".
- **Check:** in `pr-body-check.mjs`:
  - the Assumptions section's non-blank lines are exactly `none`, or each matches `^- Assumption: .+ — .+`;
  - move the 200-word budget from `warnings` to `failures` when the PR is not a draft.
- **Fail:** `## Assumptions\n- I picked the shorter message`. **Pass:** `- Assumption: refusal wording — today's text, the smallest change.`

**R24. Report blocks, beyond the first key.**
- **Rule:** implementer Report; build brief "list the Tests lines not yet built under `remaining`"; audit "None: … leave the line unticked and say why under `open`"; reviewer Report.
- **Check:** in `report-guard.mjs`:
  - **implementer:** `cycles: (\d+)/(\d+)` with b<t (and not `Assessment: incomplete`) needs a `remaining:` block of t-b indented lines, or an `open:` line starting `spec needs:`. An `audit:` line's `donewhen k/n` with k<n needs at least n-k `open` lines. `covered c/f` with c<f is treated the same way.
  - **reviewer:** `Rerun:` is `round 2`, `fix-check` or `none`; `Findings file: <path>` exists on disk. Each `Spec|Code|Claims review:` is `n findings (b blocking)` or `skipped`.
- **Fail:** `cycles: 4/9` and `remaining: none`. **Pass:** `cycles: 4/9` with five `remaining` lines.

**R25. The vendored inventory.**
- **Rule:** vendor 11, "updates the notice and the inventory in the same change". VENDORED-CODE.md's own header.
- **Check:** in `src/source-hygiene.test.ts`:
  - each first-level directory under `vendor/`, and each archive at vendor's root, appears in a backticked path in the "Where it lives" column of a VENDORED-CODE.md inventory row and in `vendor/README.md`;
  - every backticked `vendor/…` path in those rows exists.
- **Fails today:** row 17's `vendor/agent-device-proxy-0.21.28-dev-253dca0.tgz` is gone.

**R27. The `adr:` flip is mechanical.**
- **Rule:** fix brief, "set that ADR's `**Status:**` line and its row … and change nothing else". Deliver, "then the coordinator's mechanical fix-check".
- **Check:** `adr-flip-check.mjs <commit>`. Each hunk of the commit changes only a `^- \*\*Status:\*\*` line in `docs/internal/adr/NNNN-*.md`, or one row of `docs/internal/adr/README.md`. The coordinator then records `verified by: coordinator` from the script's exit code.
- **Fail:** the commit also edits a paragraph. **Pass:** two one-line hunks.

**R28. Routine PRs keep their kind.**
- **Rule:** garden-comments, "The review's kind must be `comments-only`". Audit-tests, "only test files changed". Harden-tests, "Never edit source code in this PR". Calibrate-reviews, a "docs-only PR".
- **Check:** in `pr-body-check.mjs`, by branch prefix, run `diff-kind.mjs <merge-base> <head>` and require: `comments-only` for `chore/garden-comments-`; `tests-only` for `chore/(audit|harden)-tests-`; for `chore/calibrate-reviews-`, `git diff --name-only` equal to `.agents/briefs/calibration.md`.
- **Fail:** an audit PR that touched `src/core/registry.ts`.

**R29. Test count as a review input.**
- **Rule:** spec review Q3, "A line proven by more than one new test, or a new test no Tests line asks for … is a finding [testing 7]".
- **Check:** in `review-inputs.sh`, write `tests-count.txt` with the new `it(`/`test(` call sites in `diff.patch` and the bullet count under `### Tests` in `issue.md`. This is an input fact for the spec lens, not a gate.
- **Confidence:** medium. Extending a test adds no call site, which is the intended outcome, so a lower count is fine.

**R30. Ports for external APIs.**
- **Rule:** architecture 9, "never import `fs`/`child_process` or call `Date.now()`/`setTimeout` directly in application code". Always-in-scope 7.
- **Check:**
  - widen the depcruise `no-fs-or-process` rule's `from` to `^src/` with `pathNot` `^src/ports/|test` (today it covers six modules). Add `src/http/server.ts` to the known violations, or move it behind a port;
  - add a grep test: no `\bDate\.now\(`, `new Date\(\s*\)`, `\bset(Timeout|Interval)\(` in non-test `src/` outside `src/ports/`, with a known list (`src/core/usage/index.ts:115` today) that only shrinks.
- **FP risk:** CLI-only code (`src/cli/`) may be deliberate. Decide which hosts count as application code. **Fail:** `import { readFileSync } from "node:fs"` in `src/gateway/x.ts`.

### M items

**R2. Body and comment guard.**
- **Rule:**
  - delivery 12: "Every comment, issue body, and PR body an agent writes ends with the line `*Written by an agent.*`"; budgets: "a triage report 300 words, a handoff 150, … a 'Spec updated' comment one line, the review notes comment one line per note";
  - delivery 2: "exactly one comment headed `## Handoff` with four sections: Done, Not done, Findings, Blocked on";
  - delivery 8: triage sections "*Reproduction*, *Root cause* (with file and line), *Simplest fix*, *Alternatives rejected* (at most three, one line each), *Risk* (at most three bullets), and *Side findings*".
- **Check:** in `tool-guard.mjs`, for `gh (issue|pr) (comment|create|edit)` with `--body <q>` or `--body-file <f>`, and `gh api … -F body=@<f>` or `-f body=…`, read the body from the raw command (not `code()`, which blanks quotes) or from the file. Then:
  1. The last non-empty line is `*Written by an agent.*` or `_Written by an agent._`. This is the same regex as `pr-body-check`.
  2. A body starting `## Handoff` has exactly the four labels, as bold or headings, in order, and at most 150 words outside code blocks. A `Blocked on` that is not `nothing` prints a reminder to move the label. Better: an `issue-state` job on `issue_comment.created` moves the issue to `<kind>:blocked` itself, which makes the label half automatic.
  3. A body whose first heading is `## Reproduction` has the six headings in order (Side findings optional). Alternatives rejected has at most 3 non-blank lines, and Risk at most 3 bullets. Root cause contains `\S+\.\w+:\d+`. The whole report is at most 300 words outside code, and starts `Supersedes the report above.` when the thread already has one (needs a fetch: skip the check, or warn).
  4. A body starting `Spec updated:` is one line plus the footer.
  5. In a `## Review notes` body, each bullet is one line.
- **FP risk:**
  - bodies built in a variable (`--body "$(cat x)"`) cannot be read. Refuse with "use `--body-file`";
  - `gh issue edit --add-label` carries no body and is not checked.
- **Fail:** `gh issue comment 9 --body "Done."`. **Pass:** a `--body-file` whose Handoff has the four parts, 120 words and the footer.
- **Residual:** "lead with the conclusion", "no narration".

**R31. `spec-lint.mjs <issue> [--feature]`.**
- **Rule:** the task and feature templates, delivery 7, the spec-session self-check, toolchain "Slow lane" and "Contract shapes", and the structural halves of the spec-checker categories. Input is the posted body (`gh issue view` or `--body-file`) plus the GraphQL parent and sub-issues the checker already reads.
- **Pass/fail conditions.** Each is a regex once the body is split by heading, so each is S on its own; the parser and the cases make the whole M.
  1. **Sections.** A task has `Part of #N.`, then `## Scope`, `## In short`, `## Technical spec` with `### Facts`, `### Modules touched`, `### Contract and event changes`, `### Other code on the same state`, `### Failure modes`, `### Rules in play`, `### Tests`, then `## Done when`, `## Out of scope`, `## Depends on`, in that order. `### Surface and extension points` is optional. A feature has `Request: #N|none` and its eleven business sections, then Decisions, Shared values, Behaviours and Tasks. All eight live tasks pass.
  2. **Template leftovers.** Fail on `#NNN`, a table row of only `...` cells, a bullet that is only `- ...`, or a template HTML comment still present.
  3. **Footer and parent.** The last line is the agent footer. `Part of #N` equals the GitHub parent.
  4. **Tests size.** The `### Tests` bullet count is a note above about 10 and blocking above 30, unless Scope holds a "why it cannot split" line (checker `size`; spec-session's "about 10"). The first line after the heading names an existing test file: a backticked path that exists at the body's commit.
  5. **Modules size.** Distinct `src/<module>/` paths under Modules touched: more than 20 without a Scope reason is a finding. The section and Other code on the same state each hold a `Searches:` line (template: "one line names the searches").
  6. **Failure modes.** A table with the header `Call | Outcome | What happens | Limit, counted from`, or the word `none`.
  7. **Contract wording.** When Contract and event changes is not `none`, it holds `bumps the protocol by one` and no `protocol (version )?\d+` or `PROTOCOL_VERSION_RANGE.*\d` (template: "never a version number"). When it names an event, `EVENTS.md` appears in it.
  8. **Hardware lines.** A Done when line matching `slow lane|real (simulator|emulator|device|iPhone|phone)|on a Mac with` names an `e2e/slow-[\w-]+\.test\.ts` that exists (checker `hardware`; toolchain "names the slow-lane test that proves it").
  9. **Feature, planned.** With `feature:planned` or past it, Open questions is empty.
  10. **Feature words.** Words used is not empty (an entry, or `none`).
  11. **Diagrams.** In short holds a ```` ```mermaid ```` block (template).
- **Where:** spec-session step 7, after "Self-check", before posting: blocking findings are fixed before any checker starts. The `issue-state` workflow, on `labeled` `task:ready`: fail, then demote to `task:draft` with a comment listing the lines, as the emptied-spec job does now. Deliver step 1: refuse a task that fails.
- **Confidence:** high for each rule. **Residual:** the content, which is the Opus checker's.

**R32. Facts resolve.**
- **Rule:** task template, "Source: … a `path:line` in this repo, … or a command and the output line it printed … Docs, memory or 'to re-check' is no source". Spec-session step 7. Checker `fact`.
- **Check:** in `spec-lint.mjs`:
  - read `Commit <sha>.` under `### Facts`; fail when it is absent;
  - for every Facts row, the Source cell is non-empty;
  - it does not match `\b(docs?|memory|to re-?check|TBD|todo)\b` as its whole content;
  - it is not only `website/…mdx` or `docs/…md` paths. A doc may back a fact about docs, so this one is a note when the Fact cell names code;
  - every `` `path:line[-line]` ``, and each `:line` continuation that inherits the last path, resolves: `git cat-file -e <sha>:<path>` succeeds and the line is at most the file's length at that sha;
  - every other `path:line` in the body (Modules touched, Rules in play) resolves the same way at the same sha;
  - Facts numbers are unique. A note for order: F20 sits after F22 in #966.
- **FP risk:** another tool's source (`git -C <checkout> show v<ver>:<path>`, or `node_modules/@agent-device/proxy/dist/...`) cannot be resolved in this repo. Skip paths under `node_modules/` or with a `v<ver>:` prefix, but require one of those two forms for a fact about another tool (toolchain "Other tools' source").
- **Fail:** `| F3 | … | docs |`, or `src/core/config.ts:9999`. **Pass:** `src/core/config.ts:1088-1091` at `3de46d1ff`.
- **Residual:** whether the line bears out the fact, which the checker still reads. The lint removes the cheap half of the `fact` category.

**R33. The Depends on graph.**
- **Rule:**
  - delivery 1, "A `task:ready` task runs once every issue under its Depends on is closed, or is a task of the same feature whose PR passed review";
  - spec-session, "A Depends on only when …";
  - the 2026-10-25 process review, proposals 6 (`chain`) and 7 (`depends-outside`), which it puts in the Opus checker.
- **Check:** in `spec-lint.mjs --feature`, for each open sub-issue, parse `## Depends on` lines `^- #(\d+)`. Then:
  - each number exists;
  - an open issue that is not a sub-issue of this feature is a `depends-outside` finding, printed for the maintainer;
  - a closed one is a note (needless);
  - a cycle fails;
  - the longest path and the task count print as `chain 6 of 7 tasks`.
- `runnable.mjs <feature>` prints the tasks that are open, `task:ready`, unassigned, and whose every dependency is closed or a sub-issue with an open, non-draft PR. That replaces deliver's "Check the Depends on yourself".
- **Fail:** #913 → #914 → #915 → #916 → #917 → #918 prints `chain 6 of 7`. That is a printed note, not a failure.
- **Residual:** whether a Depends on is needed (overlap), which needs code.

**R34. Behaviours rows and Tests lines.**
- **Rule:** feature template, "Every task's Tests lines are copied from this table, one line per row". Checker `untested`, "A Tests line that no Behaviours row backs, or one line per case, is a finding".
- **Check:** parse the feature's Behaviours table. Per sub-issue, the count of rows whose Task cell names it equals that task's `### Tests` bullet count. Each Tests bullet shares at least 60% of its content words with one row of its task. Every Task cell names a sub-issue, and every sub-issue has a row.
- **FP risk:** a Tests line naming an existing test to extend may be prose, not a bullet. Count bullets only.
- **Fail:** #956 has 5 Tests bullets and 4 rows. **Pass:** equal counts.
- **Residual:** whether the row's seam can see the claim.

**R35. The PR walks Done when.**
- **Rule:** coding 5, "Every task PR walks its Done when lines". Build brief, "the Done when lines as an unchecked list". Audit, "Never tick a box on intent". Delivery 9 on the last sub-issue.
- **Check:** in `pr-body-check.mjs` with a PR number on a `<kind>/<n>` branch:
  - fetch issue `<n>` and take its `## Done when` bullets;
  - each must appear, normalized (case, backticks and whitespace folded, first 60 characters), as a `- [ ]` or `- [x]` line in the PR body;
  - not draft: every one is `[x]`;
  - when the issue's parent has no other open sub-issue, the parent's `## Completion conditions` bullets must appear too.
- **FP risk:** the orchestrator may rephrase a line when it walks it. Use a prefix match and allow an appended `— <how checked>`.
- **Residual:** whether each tick is true.

**R36. Review counts from data.**
- **Rule:** deliver step 4, the counts line, where "`<b>` counts the blocking findings that review raised over all checks, `<m>` those confirmed and fixed, `<k>` its notes".
- **Check:** `review-ledger.mjs`, untracked today, already holds the findings JSON. Let it also write the `## Review` section's first two lines with `issue-body.mjs <M> --pr set-section Review`. `pr-body-check` then recomputes them from the ledger JSON and fails on a mismatch. The findings schema needs one more field (`severity: blocking|note`) or a separate notes count, because notes are not in the file today.
- **Residual:** none for counting. The Rejected lines stay prose.

**R37. One test per `test:` commit.**
- **Rule:** build brief, "Commit the test and its stubs, one test per commit". A line that lists cases is one test.
- **Check:** a pre-push step on `<kind>/<n>`. For each commit in `origin/<base>..HEAD` whose subject starts `test: `, count added lines in test files matching `^\+\s*(it|test)(\.each\(|\()`; fail when it is above 1. When the commit changes a file outside the tests, its added non-test lines should hold only `export` declarations or stub bodies. That second part is a warning only.
- **Fail:** a `test:` commit adding three `it(` calls. **Pass:** one `it.each(` with a table.
- **Residual:** extend-not-copy (testing 7).

**R38. Internal-file test imports need `why:`.**
- **Rule:** testing 6, "A test of an internal file earns its place only for pure logic with many cases … or for an ordering the surface cannot force, and says which in a `why:` comment above its `describe`". Audit brief, the same.
- **Check:** in `test-lint.mjs`, for a test file the diff adds or whose import lines it changes:
  - the file sits in a directory with `index.ts`;
  - a new import has a `./x.js` specifier that is not `index`, `testing` or `test-*`;
  - then a `why:` comment must sit within the 3 lines above the first `describe(`.
- **Baseline:** 93 such files tree-wide, 3 with the comment. Diff-scoped, so the old ones are left alone, the same deal comment-lint makes.
- **Fail:** a new `src/leasing/wait-queue.test.ts` importing `./wait-queue.js` with no comment. **Pass:** `// why: pure planner, 14 cases` above the describe.
- **Residual:** whether the reason is true.

**R39. Lenses match the diff kind.**
- **Rule:** REVIEW "Routing", "ADR-only: spec. Docs or comments: spec and claims. Tests: spec, code/tests and affected claims. Other changes: spec and code/both …". Deliver step 4, "`skipped` … for a review the diff's kind left out".
- **Check:** in `pr-body-check.mjs`, run `diff-kind.mjs <merge-base> <head>`. Fail when:
  - `Code review: skipped` and the kind is `full`, `large` or `tests-only`;
  - `Spec review: skipped` on a `<kind>/<n>` branch, where an issue exists;
  - `Claims review` is not `skipped` on `adr-only`. That is a warning; extra lenses are allowed.
- **Residual:** "affected claims" (whether claims had to run on a full diff).

**R40. Lens output shape.**
- **Rule:** the three review briefs' Output sections: "One line per defect, in this form and no other"; "at most 400 words besides the list"; "at most two" notes; "End with `Assessment: …`". Code brief, "Restore the tree before you report".
- **Check:** extend `report-guard.mjs`'s SubagentStop matcher with `spec-reviewer|code-reviewer|claims-reviewer`, assuming nested sub-agents fire SubagentStop (to verify).
  - The last line matches `^Assessment: (complete|incomplete — .+)$`.
  - Each line starting `F\d` matches `^F\d+ [BN] \S+:\d+ .+ \[[^\]]+\] ev: .+`, or the line is `F0`.
  - At most 2 `N` lines.
  - At most 400 words outside the list lines (`path: … ok|F\d`).
  - For a code-reviewer, `git -C <cwd> status --porcelain` is empty.
- **Residual:** content.

**R41. Claim script.**
- **Rule:** delivery 2, "it never touches an issue that already has an assignee". Delivery 1, the labels that are work. Triager step 1.
- **Check:** `claim.mjs <n> [--triage]` runs `gh api issues/<n>`, then refuses (exit 1) when there is an assignee, when the label is not one of `bug:new` (with `--triage`), `bug:ready` or `task:ready`, when the issue is closed, or, for a task, when R33's runnable test fails. Then it assigns `@me`. `tool-guard.mjs` refuses a raw `gh issue edit … --add-assignee` and points at the script.
- **Residual:** none.

**R42. Round lines and notes once.**
- **Rule:** REVIEW, "one full round, one targeted round 2, and one final targeted fix-check"; "Notes go out once, after the last check". Deliver, "one `Round <r>: <full commit>` line per check".
- **Check:** in `pr-body-check.mjs`, ledger `^Round (1|2|fix-check): [0-9a-f]{40}$` lines:
  - at most one `1` and one `2`, and `1` first;
  - every sha is an ancestor of head, which needs `git merge-base --is-ancestor` after a fetch, so warn when the sha is unavailable;
  - at most one comment headed `## Review notes`.
- **FP risk:** the hardware loop adds a fix-check after the cap (deliver item 3), so do not cap fix-checks at one. Medium confidence.

**R43. Public surface reaches the website.**
- **Rule:** documentation 9, "Nothing generates or checks these pages: the author and the reviews keep them true". Always-in-scope 1.
- **Check, part 1:** a CI job like protocol-bump. When the diff changes any of these, it must also change a file under `website/src/content/docs/`, or a commit must carry the trailer `Docs: none (<reason>)`:
  - `src/cli/tree.ts`;
  - the config defaults or validator in `src/core/config.ts`;
  - the `ERROR_TABLE` in `src/contract/errors.ts`;
  - an MCP tool definition;
  - a route declaration under `src/http/`;
  - `src/client/index.ts` or `src/admin/index.ts` exports;
  - the `EventName` union.
- **Check, part 2:** a catalog test: every key path the config validator accepts appears as `` | `key` | `` in `reference/configuration.mdx`.
- **FP risk:** an internal refactor of a listed file. That is what the trailer is for.
- **Residual:** whether the pages are right.

**R44. Vendored change, same-change inventory.**
- **Rule:** vendor 11.
- **Check:** a CI job. When `git diff --name-status` shows an `A`, `D` or `R` under `vendor/<dir>/` (other than `NOTICE.md`), or an `M` of `SHA256SUMS.txt` or of the upstream commit line in `NOTICE.md`, the diff must also touch `vendor/<dir>/NOTICE.md`, `docs/internal/VENDORED-CODE.md` and `vendor/README.md`.
- **FP risk:** a change to "our" files in `vendor/screen-capture/` needs no inventory change. Hence the `A`/`D`/`R` restriction. Medium confidence.

**R45. Wire input bounded.**
- **Rule:** always-in-scope 8, "validated for shape and bounds before it is used or stored". Safety 10. Task template, "Every new field read from the wire … its bounds".
- **Check:** in a diff lint over added lines in `src/contract/*.ts` (not tests), `z\.string\(\)` with no `.max(`, `.length(`, `.regex(`, `.uuid(`, `.datetime(` or a known bounded helper on the same expression fails. So do `z\.array\(` with no `.max(` and `z\.record\(`, unless a `why:` sits on the line above.
- **Baseline:** 197 of 214 `z.string()` have no `.max` tree-wide, so it must be diff-scoped. Bounds may also live in refinements. Medium confidence.
- **Residual:** "match by structure, never substring", and "unknown fails closed".

**R46. Factory surface.**
- **Rule:** architecture 18, "It does not export the classes it is built from … An index that predates this rule is not a finding until a change grows it".
- **Check:** for each `src/**/index.ts` in the diff, resolve the added export names with the TS compiler API. Fail when one is a class declaration, or when there is an added `export class`. Allow error classes (`extends Error`).
- **Residual:** "the composition root imports … only the factory".

**R47. ADR status at merge.**
- **Rule:** delivery 10, "flips to *Accepted* when the feature closes". README, "An ADR that is *Accepted — not yet implemented* with no open feature behind it is a gap".
- **Check:** in `merge-pr.sh`, when merging a stack whose top PR closes the last open sub-issue of a feature, every `docs/internal/adr/*.md` the stack adds or changes must read `**Status:** Accepted` (not Proposed, not "not yet implemented"). Also a weekly report of ADRs at "not yet implemented" that no open feature's Decisions section names.
- **Confidence:** medium. The process review proposal 22 moves the flip into the last task PR, and the check holds either way.

**R48. Opus on high-risk code review.**
- **Rule:** REVIEW "Routing", "Ownership, destruction, persistence/recovery, concurrency, trust boundaries … require Opus/high code review, regardless of LOC".
- **Check:** in `tool-guard.mjs`, for an Agent call with `subagent_type: code-reviewer` and `model` set and not `opus`, read the `inputs:` path from the prompt. When `<inputs>/diff.patch` touches the strict areas (toolchain "Project checks") or `src/contract/` validators, refuse.
- **FP risk:** the `pilot: sonnet` replay runs, which can be exempted when the prompt says `stage=replay`.
- **Residual:** semantic risk outside the named paths.

### L items

**R49. Per-PR mutation on strict areas.**
- **Rule:** testing 3, "In the strict areas … production code that can be deleted with a green suite is untested". Audit "Covered" with `covered <c>/<f>`.
- **Check:** a CI job, only on PRs whose diff touches the strict areas, runs `pnpm mutate <merge-base> --max-lines 300` restricted to those files. Surviving mutants post as annotations, then as a failure once it is calibrated.
- **Cost:** CI minutes and noise from equivalent mutants. Today it runs weekly on `main` only.

**R50. Copies that should be a table.**
- **Rule:** testing 1 and 7, "as one table when the cases differ only in data, never one test per case". Audit-tests `TABLE`.
- **Check:** parse added `it(` and `test(` blocks with the TS AST. Normalize literals and identifiers. Two sibling blocks in one `describe` with the same token sequence are a finding.
- **Residual:** whether they claim one behaviour.

## Spec-checker categories: what a lint can take before the Opus checker

| Category | Structural part (`spec-lint.mjs`) | Needs code or judgement (stays with the checker) |
|---|---|---|
| contradiction | none worth it | all |
| unverifiable | a Done when line with no command, test path or file: a note only | whether a reviewer could check it |
| untested | Behaviours rows == Tests bullets per task (R34); a Tests line per case: a bullet whose text is a single literal case | each sentence that states visible behaviour has a line; the seam can see the claim |
| failure-mode | the Failure modes table has its columns or `none` (R31.6) | which failures are missing; bounds |
| interaction | a `Searches:` line with hit counts, or `None` (R31.5) | which writers of the state exist |
| derived-list | Modules touched has a `Searches:` line | whether the list is complete |
| overlap | Depends on refs, cycle, depends-outside, chain (R33) | two tasks touching the same lines |
| hardware | a slow-lane Done when line names an existing `e2e/slow-*.test.ts` (R31.8) | whether a line needs the lane but does not say so |
| undefined | Words used present (R31.10) | which terms need defining; "as today" claims |
| size | Tests bullets above 10 or 30; distinct modules above 20 without a Scope reason (R31.4, R31.5) | none |
| fact | a commit line, a non-empty non-docs Source, every `path:line` resolves (R32) | the line bears the fact out |
| boundary | none | the receiver accepts the value |
| shared-values | Written by and Read by cells name sub-issues; a value cell repeated verbatim in a task (low confidence) | values two tasks use that the table lacks |
| (feature) completion | each Completion condition bullet appears in the Tasks section with a `#n` | whether that task delivers it |

The structural share is roughly half of the categories by count, and most of the "writing findings" the spec session fixes itself. It is none of the decisions, which are what round 0 exists for.

## Not convertible (needs judgement)

- testing 1, the body proves the title: needs the meaning of the title.
- testing 2, the test fails for the right reason: only a probe shows it. `probed p/t` is guarded; R49 is the mechanical version.
- testing 3, what a caller can see: visibility is semantic.
- testing 4, an invariant test sees its whole rule: needs the rule's scope.
- testing 6, a fake port's sequence is not asserted unless order is the claim.
- testing 7, extend instead of copy; one claim, one level. R37 counts; the choice is judgement.
- testing 8, a property shared by every instance is one test.
- testing 9, a regression test only for a bug that reached `main`.
- testing 10, the remaining shapes: computed expected values, state read from a copy, an unstraddled time boundary, order read from the end state.
- architecture 1, 2, 3, the core is platform-agnostic. A term grep in core hits 14 lines, all comments or event names: too noisy.
- architecture 4, 5, a module boundary for observers versus a workflow step.
- architecture 6, state only through the transition function. A grep for direct `state =` writes is possible, but the false positives need a look.
- architecture 7, 8, destructive verbs only through the core; a thin CLI.
- architecture 10, one place for a rule. Fallow duplication catches copies of code, not of decisions.
- architecture 11, 12, bounded waits, budgets that do not reset, exits that leave one named state.
- architecture 13, claims true. That is the claims lens; `stale-refs.sh` feeds it.
- architecture 15, 16, 19, 20, 21, dependency direction for "optional" components (partly depcruise already), pure policy, when to add an extension point, a host naming an implementation.
- architecture 17's content: a `why:` that says what. The shape is mechanical already.
- safety 1 to 4, 6 to 10: ownership, leased devices, rules that propose, consent, attribution, reconcile, fail closed, wire claims. Behaviour, covered by tests.
- safety 5: probably pinned by `src/cli/index.test.ts` already (it mentions `--yes`); check.
- events 2 to 6: facts not commands, post-commit emit, never await, isolated handlers, stable payloads.
- coding 1 and delivery 3: read the body, not the thread. A guard could refuse `gh issue view --comments` for the implementer, but the handoff and decision reads make it messy.
- coding 2 and delivery 3: what counts as a small gap.
- delivery 4: reconcile first (needs the comment meaning).
- delivery 5: never rewrite a reporter's body. `issue-body.mjs` refuses this now; a raw `gh issue edit --body*` could be refused once that script is the only path (S).
- delivery 6: outcomes, not implementation.
- delivery 12: short, plain, conclusion first.
- documentation 1, 6, 8: which audience; links run one way (the website side is mechanical already); point at a value's source. A number-word lint for "seven commands" is too noisy.
- REVIEW: risk routing semantics; deduplication by defect class; verification evidence; impact classes; the safety-class probe before a downgrade.
- vendor 1 to 10: what counts as third-party; deviations with reasons; "never patch a binary" (the SHA check covers it); planned consumers.
- spec-session: interview rules, ADR need, Explain.
- deliver: "decide, then tell", park reasons, status lines.
- briefs: four Red questions, tracer bullet order, "never build a layer ahead", "never refactor between cycles", fix-every-instance search.
- implementer: "read code narrowly". A guard on `cat` of large tracked files is possible (M), but the value is low.

## Appendix: already mechanical (the baseline)

**`tool-guard.mjs` (PreToolUse, sub-agents):**
- the "Checks agents never run" list (scripts, tools, node scripts, `npx` and `pnpm exec`);
- git hook bypass (`--no-verify`, `LEFTHOOK=0`, `core.hooksPath`, `LEFTHOOK_EXCLUDE` other than `fallow`);
- `isolation` on stage agents;
- a test runner with `timeout` under 300000;
- background jobs (`run_in_background`, a trailing `&`);
- loops that sleep;
- bare `cat > file`;
- `test:e2e` with no files, and `test:console` without Chromium and spec files.

**`report-guard.mjs` (SubagentStop for implementer, reviewer, hardware-verifier):** the report block's first key; the reviewer's `Assessment:` line; an audit report's `audit:` line with `probed p/t` and p equal to t.

**`budget-guard.mjs`:** stall on the same Bash command and result; token and turn limits per agent and per session; hard kill.

**`settings.json`:**
- deny: `--no-verify` and `-n`, `push --force` and `-f`, `reset --hard`, `branch -D`, `gh pr merge`, merge APIs, `gh release`, `gh workflow run`, rulesets and protection, `gh repo delete`, npm and pnpm publish;
- ask: `test:e2e:slow`.

**lefthook pre-commit:**
- oxfmt;
- oxlint (the gateway's import allow-lists);
- depcruise: `past-index` (architecture 14), `testing-only-in-tests`, `definition-is-light`, direction rules including `no-fs-or-process` for core, leasing, agent-device, host-load, stream and alerts, the cycle check, known lists that only shrink;
- `comment-lint.mjs` (the shape of architecture 17);
- typecheck.

**lefthook pre-push:** `fallow audit`, `protocol-bump-check.mjs`, `typecheck:e2e:types`.

**CI (`ci.yml`):** typecheck and the e2e typecheck, lint and `lint:comments`, format check, unit, timing project, three e2e shards, four console shards, Fallow, protocol bump. `website.yml` runs the build and `check-openapi.mjs`; `real-proxy.yml` runs the proxy lane.

**`issue-state.yml`:**
- one state label;
- demote a task whose Technical spec is emptied;
- the needs-info reply and the stale close;
- close a feature on its last sub-issue, then its request;
- a closed PR releases its claim;
- a three-day stale claim is released;
- a `<kind>/<n>` PR closes `#n` only;
- `pr-body-check.mjs`: footer; Review counts line; Rejected tags; no "spec needs"; Status and Assumptions sections on delivery branches; a ledger comment exists; `Assessment: incomplete` fails; budget (a warning only).

**`merge-pr.sh`:** open and ready; no `needs-hardware`; `pr-body-check`; CI green with a flaky rerun; mergeable; the stack merged all or nothing.

**Scripts that remove a by-hand step:**
- `issue-body.mjs` (untracked): one-match replace, keeps the footer, refuses `request:` and `bug:` bodies;
- `review-ledger.mjs` (untracked): posts the ledger, refuses unknown SHAs and round mismatches, runs `pr-body-check`;
- `review-metrics.mjs --findings`: the findings schema (unique id; role, class, path; outcome and round enums; a duplicate names its canonical);
- `review-inputs.sh`: blind inputs from the pinned base, `tests-after-red.patch`, `assumptions.md`;
- `stale-refs.sh`, `diff-kind.mjs`, `ci-triage.mjs` and `ci-failures.mjs`, `stack-sync.sh` (merge forward only), `slow-e2e.sh` (lock, detached, machine checks), `worktree.sh`, `pr-shas.sh`.

**Repo tests:**
- `docs-manuals.test.ts`: a manual per module, CLAUDE.md that only imports it, at most 150 lines, backticked paths and links exist, ARCHITECTURE links every manual;
- `docs-audience.test.ts`: website pages and README name no internal path or ADR; markdown under `docs/` sits only in `internal/`;
- `source-hygiene.test.ts`: a vendor directory has NOTICE.md and LICENSES texts, no bare LICENSE, SHA256SUMS digests match, no committed binaries or NUL bytes;
- `build-capture.test.ts`: NOTICE and LICENSES copied to `dist` (vendor 8);
- `expected-failures.test.ts`: no test written to pass by failing;
- `adr-index.test.ts`: a row per ADR file, ascending;
- `lint-rules.test.ts`: the depcruise and oxlint configs themselves;
- `test-lanes.test.ts`: timing files are out of unit and mutation, slow and physical tags;
- `labels.test.ts`;
- `bus/index.test.ts`: EVENTS.md names equal `EVENT_NAMES`;
- `host-load/boundary.test.ts`;
- `http/openapi.test.ts`.

**Weekly routines:** `harden-tests` (mutation), `audit-tests`, `garden-comments` (`comment-lint --all`), `calibrate-reviews`, `recurring-findings`, which already turns recurring review classes into proposed checks.
