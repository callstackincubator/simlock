# Findings rejected in the 4 weeks to 2026-10-19

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 511 rejected findings in all.

## spec review

- #651 ui/src/model/overview.test.ts:64 the new comments break the comment lint — CI's `lint:comments` is what rules on it; the lint then rejected six comments and that fix went through the fix check.
- #615 removed test left a bare JSON-RPC frame path untested — not blocking: the reviewer marked it non-blocking, and the behaviour is unchanged.
- #576 the slow-lane tests have not passed — proven by the hardware stage, not by review
- #576 the gateway check on real devices is not done — a maintainer check on hardware
- #576 (round 2) the slow-lane Android test has not passed — same as above
- #576 (round 2) the gateway check on real devices — same as above
- #605 the known-cycles ratchet rises from 6 to 8 against architecture rule 14 — the maintainer chose to keep it for now (option A); the cycles go when agent-device stops importing `src/http`
- #601 src/core/config.ts:429 Assumption 4 skips a module's `check` on gateways, not conservative — not blocking: skipping avoids failing a start over values a gateway ignores; spec and docs do not require it

## code review

- #679 src/core/reclaim-coordinator.test.ts:381 architecture 17 forbids this comment — not blocking: it gives a real why, every fact holds, lint passes
- #606 src/modules/conformance.test.ts:142 beforeDrain assertion can never fail — not blocking: a hang fails by timeout, so the test can still fail
- #605 same finding as the spec one — same reason
- #582 `src/link/link-portable.test.ts:41` title covers one direction only — from main (#579), not this PR.
- #581 the path check skips a directory named without a trailing `/` — the manuals write directories with a trailing slash; no state is wrong.
- #567 the gateway copies the worker's probe-default decision (main.ts:845) — the shared factory is used and behaviour is the same
- #565 duplicate of a spec finding on optional `nowMicros`, kept once
- #562 src/link/link-channels.test.ts:687 fails only by 5 s timeout when waiters never drain — not blocking: named test still goes red for the right reason

## claims review

- #689 src/ports/daemon-launcher.ts:41 "the daemon's own sink only appends" is false of a hand-started daemon — [incorrect] the sentence is scoped "for an auto-launched daemon", where it is true
- #674 R1 src/ports/daemon-launcher.ts:17 "the 30 s a caller gives the CLI process" is stated nowhere — incorrect: it is stated in code the change depends on, `e2e/console/fixtures.ts:109` (`cli(["daemon", "start"], env, { timeout: 30_000 })`) and `e2e/helpers/cli.ts:163` (`waitForExit(timeout = 30_000)`)
- #606 src/module-registry/AGENTS.md:5 entry is index.ts not the definition file — not blocking: index.ts only re-exports the definition
- #583 ADR 0022 line 429 says "KNOWN-PITFALLS gets an entry" — ADRs are history and stay as written.
- #582 four stale references to removed ARCHITECTURE.md sections inside COMPONENTS.md and KNOWN-PITFALLS.md — both files are deleted by #583, which merges with this PR.
- #568 docs/CONSOLE.md:152 page description omits the Load panel — incomplete wording, no wrong state
- #509 `toolchain.md` package.json names only a short hash — not blocking: still true via vendor/README.md
- #468 src/leasing/lease-acquisition-coordinator.ts:299 cites ADR 0023, not in docs/internal/adr/ — ADR 0023 is accepted on draft PR #465, merged by the maintainer.
