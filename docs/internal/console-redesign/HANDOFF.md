# Console redesign delivery handoff

The maintainer requested a stop after currently started work on 2026-11-07.
Do not automatically launch further builds, reviews or page stages.

## References and delivery state

- Feature: [#1425](https://github.com/callstackincubator/simlock/issues/1425),
  still `feature:spec`. Its posted body and subissues are the implementation specs.
- Approved design package: commit `3b8c44d10`; issue links/model update:
  `5813a0a15`; foundation spec amendments: `edf14f5dc`; Fleet reference
  exceptions: `58226a731`. Parent branch: `feat/console-ui-redesign`.
- Use GPT 6.1 Sol for delivery agents. Stage 0 precedes parallel stages 1–6;
  stage 7 follows their integration. Retain one feature PR stack and merge
  through the repository gate; do not merge a partial feature to main.
- Original PNGs remain unchanged. PLAN and DESIGN record the explicit
  Baselines and Fleet exceptions. Every other visual requirement applies.
- `.console-review/` is unrelated, untracked and preserved.

## Work started

Stage 0 ([#1426](https://github.com/callstackincubator/simlock/issues/1426))
passed independent spec checking after three findings were corrected. Its
isolated build stopped after the first shell cycle at the maintainer's
request. The final observed issue label is `task:draft` despite its earlier
promotion; reconcile the posted spec and label before claiming it again.
The claim is released with one issue Handoff comment. No page implementation
was started, and no audit, PR review or merge was performed.

## Spec checks

| Stage / task | Latest independent result | Remaining before delivery |
| --- | --- | --- |
| Feature #1425 | Two initial findings; corrected in posted bodies | Targeted recheck of baseline acceptance, scheduling and subsequent shared-value edits; final feature promotion |
| 0 / #1426 | Ready: 0 of 3 open, no new findings | Finish current build, then audit/review when delivery resumes |
| 1 / #1427 | Ready: 0 of 2 open, no new findings | Final observed label is draft; reconcile/re-promote on resume; waits for reviewed foundation |
| 2 / #1428 | Original control finding closed; one dependent visual-wording contradiction | Acceptance clauses now aligned; targeted fix-check still needed; remains draft |
| 3 / #1429 | Two findings: action-test ownership and clipboard failure | Both amended in posted task/parent; targeted recheck still needed; remains draft |
| 4 / #1430 | Two test gaps and one legacy-query note | Overlay/aspect-ratio cases and legacy key corrected; clipboard cases aligned; targeted recheck still needed; remains draft |
| 5 / #1431 | Ready: zero findings | Still draft; may be promoted after feature reconciliation |
| 6 / #1432 | Not independently checked | Initial task check |
| 7 / #1434 | Not independently checked | Initial task check |

All nine posted specs passed structural lint after the foundation corrections.
Later targeted changes also passed lint where reported; parent retains only
the expected dependency-chain note. Spec readiness is not implementation,
runtime, screenshot, accessibility or PR-review evidence.

## Recorded delivery decisions

- Use derived light theme, inspector drawer strictly below 1280 CSS px,
  pane at 1280, and view-only streaming. No device input or backend scope.
- Baselines use supported ready/stale rows, All/Stale/Ready filters and a
  **Prepare baseline** link to the existing preparation instructions. No
  fabricated build progress or new lease-ending save workflow. Preserve
  row/pill geometry and record the data/filter/link exceptions in paired images.
- Fleet **Add worker** links to existing joining instructions. The drawn
  **Release leases** control becomes **View leases**, linking to `/leases`
  without a write. Record these exceptions in stage-2/stage-7 paired images.
- Foundation owns mechanical replacement of every screen CSS `--chip` and
  `--field` consumer, plus shared table props and their public-props tests.
- Redesign owns overlapping worker/device/warm-pool hunks before draft
  device-management work. Those drafts adapt afterward; no blanket external
  dependencies or product scope were imported.
- Screens PR #1256 is not a dependency. Recheck its actual head/merge-base
  before streaming integration, preserving optional capture acquisition,
  cancellation ownership and extracted renderer compatibility if present.
- Overview tests pin all six KPI destinations and supported ranges. A
  refused requests read shows unavailable Queue/Waiting rather than false
  zeroes; other cards remain usable. Preserve existing unsupported fallback.
- Stage 3 owns lease-only assertions in `e2e/console/actions.spec.ts`,
  splitting its combined lease/worker test without changing worker assertions.
  Stage 2 adds worker-layout coverage in `e2e/console/workers.spec.ts`.
- Copy failure (API absent, rejected, or unresolved 5000 ms after click)
  announces "Couldn't copy. Select and copy the id." Keep focus on Copy,
  retain selectable full identity, publish no false success or late success.
  No legacy workaround or daemon write. Test deadlines with a fake clock.
- Streaming tests must bind overlays to actual metadata/statistics differing
  from the reference and preserve a non-phone landscape picture ratio.
  Legacy Screen drawer links use `?drawer=screen`, not `drawerTab`.

The amended issue bodies mark delivery decisions pending the maintainer.
When PRs exist, add the required concise Decision taken comments; none had
been created when these decisions were recorded.

## Resume

Read the final foundation result below and its PR Status/Handoff first.
Resume remaining build cycles instead of restarting completed work. Preserve
the reference commits in the bottom PR. Complete spec checks/promotions,
foundation audit and pinned spec/code/claims review before page builds fork.
Every page needs its named Chromium tests, both-theme axe with contrast,
1440×900/1280×800/390×844 captures, actual render comparison, paired PR
images, and website docs in the same change. No merge or completed redesign
is claimed by this handoff.

## Foundation result

- Draft [PR #1435](https://github.com/callstackincubator/simlock/pull/1435),
  branch `task/1426`, head `dc4350d29f757a3fdaf0eee8b833cad07a9d6ba8`.
  Clean checkout at `/Users/szymon.chmal/.t3/worktrees/pitlane/t3-f18f2fb8`;
  local HEAD matches the pushed branch. PR targets main and retains the
  approved design package. Keep it as the bottom of the feature stack.
- One of nine spec lines built. Chromium `shell.spec.ts`: 13/13 passed,
  including actual color-contrast axe in both themes. Website build/OpenAPI
  check and commit/push hooks passed. Hosted CI was running at builder
  handoff; no hosted-green claim. PR is draft and unreviewed.
- Remaining: holder helpers/chips, capped slots, opaque device paths,
  shared-control behavior, deterministic render harness, complete visual and
  viewport acceptance, public-props DataTable coverage, and retired-token
  substitution. Account styling and shared primitives remain incomplete.
- Diagnostic dark/light token/proxy PNGs are under the builder checkout's
  ignored `docs/internal/console-redesign/current/`. They contain live/loading
  data, not deterministic render acceptance or paired PR evidence.
- Initial red failed on sidebar bounds. Proxy daemon shutdown left its
  fixture stream open; passing reconnect coverage uses browser
  offline/return-to-tab. Fallow passed with advisory CSS/complexity warnings.
- No further delegates will be launched for this stopping request. Resume
  the remaining build cycles before audit or review; do not fork page builds
  from this incomplete foundation.
