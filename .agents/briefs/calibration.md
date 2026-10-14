# Findings rejected in the 4 weeks to 2026-10-14

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 484 rejected findings in all.

## spec review

- #509 `e2e/slow-agent-device.test.ts` short sample gap stays green — not blocking: Assumption 1 accepts it
- #382 the title "within the configured grace" promises more than the < 3 s bound proves — not blocking: the likely regression (the option ignored, so the 10 s default applies) fails the < 3 s assertion by name; only a grace between 0.1 s and 2.8 s gets through
- #497 edge.test.ts:493 "no idempotency key" unproven — unobservable at the daemon seam (Assumption 2)
- #497 allocate.ts:77 unknown target silently ignored — decided by Assumption 5
- #497 host.ts:42 randomUUID bypasses the IdGenerator port — no rule requires it; Assumption 4
- #497 front.ts:91 /rpc matched by exact path only — speculative, no evidence the proxy routes that path
- #497 edge.test.ts:515 no baseline for "offers no download" — duplicate of the code finding at :514, fixed
- #496 src/core/doctor.test.ts:463 optionalModules order unproven — duplicate of the code finding, fixed there

## code review

- #509 `e2e/helpers/env.ts` `restart()` has no timeout of its own — duplicate of a spec finding, fixed under it
- #509 `e2e/slow-agent-device.test.ts` `session list` exit code unchecked — not blocking: weakens no stated check
- #509 `e2e/helpers/env.ts:384` `restartSteps` keeps running after the 90 s limit — not blocking: slow-lane helper, teardown only
- #509 `src/agent-device/front/request-rules.ts:236` emulator name fallback may match another agent's emulator — not blocking: speculative
- #507 `allocate.ts:325` the "absent target reads as mobile" rule is decided twice — not blocking: both places give the same answer today, and no rule is broken
- #497 edge.test.ts:849 repeated cancel — duplicate of the spec finding at :849, fixed
- #495 supervisor.test.ts:1099 deleting removeRecord stays green — duplicate of the spec finding, fixed
- #495 supervisor.ts:745 stop-waiter removal untested — the leak is not observable without asserting private state

## claims review

- #509 `toolchain.md` package.json names only a short hash — not blocking: still true via vendor/README.md
- #468 src/leasing/lease-acquisition-coordinator.ts:299 cites ADR 0023, not in docs/internal/adr/ — ADR 0023 is accepted on draft PR #465, merged by the maintainer.
- #468 docs/EVENTS.md:26 "one-lease-per-requester" wording is stale — the default limit is still 1; the name is dated, not false.
- #468 src/leasing/lease-acquisition-coordinator.ts:322 "one-lease-per-requester check" is stale — it still describes the default limit.
- #462 src/daemon/dispatcher.ts:135 execEnv doc says driver keys are "layered on top"; unsetEnv now removes keys — not blocking: still true of the layering; unsetEnv is documented at the use site
- #458 src/leasing/lease-release-coordinator.ts:86 set doc omits return reclaims — incomplete, not false; deleted under rule 17
- #458 src/contract/schemas.ts:204, src/core/doctor.ts:257, src/core/registry.ts:123 — each gives a why
- #458 src/daemon/server.test.ts:2032, :3087, src/leasing/lease-release-coordinator.ts:165, :274 — each gives a why (round 2)
