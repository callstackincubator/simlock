# Findings rejected in the 4 weeks to 2026-10-26

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 521 rejected findings in all.

## spec review

- #907 the "40 requests a minute" bound fails under load [incorrect] — it is stated for an idle tab, which has no events.
- #907 ADR 0037 action events are left unmapped [incorrect] — the #905 event map covers all five.
- #878 R5 `parseUpdaterArgs` tests are unasked — [incorrect] always-in-scope items 4 and 8 ask for them
- #878 R13 extra assertions in "old daemon stays up" are unasked — [incorrect] they prove the R4 fix (testing 9)
- #878 R14 scenarios "holds the socket" and "daemon start never exits" are unasked — [incorrect] they prove the R1 fix (testing 9)
- #780 going back to page 1 on search needs more proofs — [incorrect] the model test and one browser line are what the Tests line asks for.
- #773 the dispatcher tests for `limit` alone duplicate the history test — [incorrect] they cover the dispatchers' routing condition, which the history test cannot reach.
- #651 ui/src/model/overview.test.ts:64 the new comments break the comment lint — CI's `lint:comments` is what rules on it; the lint then rejected six comments and that fix went through the fix check.

## code review

- #974 the `lease_status` test fails by timeout, not on an assertion, when `run_on_device` goes back on the queue (src/mcp/server.test.ts:881) — [incorrect] a hung `lease_status` is the failure its title names
- #879 edge.test.ts:827 title "(`false` for a virtual one)" has no case — [incorrect] the virtual case is at :754 and :770-777
- #679 src/core/reclaim-coordinator.test.ts:381 architecture 17 forbids this comment — not blocking: it gives a real why, every fact holds, lint passes
- #606 src/modules/conformance.test.ts:142 beforeDrain assertion can never fail — not blocking: a hang fails by timeout, so the test can still fail
- #605 same finding as the spec one — same reason
- #582 `src/link/link-portable.test.ts:41` title covers one direction only — from main (#579), not this PR.
- #581 the path check skips a directory named without a trailing `/` — the manuals write directories with a trailing slash; no state is wrong.
- #567 the gateway copies the worker's probe-default decision (main.ts:845) — the shared factory is used and behaviour is the same

## claims review

- #963 "A worker that joins a gateway writes none" (agent-device.mdx:114) is false — [incorrect] config load refuses `http.enabled` on a joined worker (`src/core/config.ts:800-806`), so the profile step takes its off path.
- #689 src/ports/daemon-launcher.ts:41 "the daemon's own sink only appends" is false of a hand-started daemon — [incorrect] the sentence is scoped "for an auto-launched daemon", where it is true
- #674 R1 src/ports/daemon-launcher.ts:17 "the 30 s a caller gives the CLI process" is stated nowhere — incorrect: it is stated in code the change depends on, `e2e/console/fixtures.ts:109` (`cli(["daemon", "start"], env, { timeout: 30_000 })`) and `e2e/helpers/cli.ts:163` (`waitForExit(timeout = 30_000)`)
- #606 src/module-registry/AGENTS.md:5 entry is index.ts not the definition file — not blocking: index.ts only re-exports the definition
- #583 ADR 0022 line 429 says "KNOWN-PITFALLS gets an entry" — ADRs are history and stay as written.
- #582 four stale references to removed ARCHITECTURE.md sections inside COMPONENTS.md and KNOWN-PITFALLS.md — both files are deleted by #583, which merges with this PR.
- #568 docs/CONSOLE.md:152 page description omits the Load panel — incomplete wording, no wrong state
- #509 `toolchain.md` package.json names only a short hash — not blocking: still true via vendor/README.md
