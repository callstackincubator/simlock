# Findings rejected in the 4 weeks to 2026-10-12

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 442 rejected findings in all.

## spec review

- #456 src/leasing/lease-acquisition-coordinator.ts:720 no test shows `#heldByOlder` holds back a device for every older matching waiter — the maintainer accepted it as reviewed
- #456 src/leasing/lease-acquisition-coordinator.ts:767 a failing lease write repeats the presence read without pause — not reproduced: 20 flushes gave 1 call
- #456 src/leasing/lease-acquisition-coordinator.ts:183 UNKNOWN_MODEL loses osVersion on the wire — a worker puts no details on the wire for any UNKNOWN_MODEL
- #456 src/gateway/fleet-coordinator.test.ts:4554 forwarded input not checked for physical — the title names the virtual request, not what was forwarded
- #455 e2e/helpers/env.ts:248 the new waitFor branch has no test that goes red [testing 3] — not blocking: testing 3 covers production code; this is an e2e helper
- #453 src/daemon/main.test.ts:693 count read with no macrotask settle after the write is reached, so a mutant passes — not true: making startup run `void leasing.settleRequests()` fails the test (expected 2 to be 1)
- #449 `src/core/physical-enrollment.test.ts:305` no test proves INTERNAL for a throwing inspection — titles now match bodies; `dispatcher.test.ts:3392` proves pass-through
- #449 `src/contract/protocol.ts:16` the comment no longer names `device.add` as the reason for the bump — rule 17 forbids it; Done when 7 was changed

## code review

- #456 e2e/physical-devices-core.test.ts:202 title claims the retry waits for retryBackoffMs — the title only says when the record is ready, which the body proves
- #456 src/leasing/lease-acquisition-coordinator.ts:660, :601, :384 test `request.physical` instead of `lineOf` — they pick a flow, not a queue line; no input diverges
- #456 src/gateway/fleet-coordinator.ts:1347 and src/gateway/routing.ts:44 repeat the physical/virtual split — they choose stages or the forwarded model, not a queue line
- #456 src/leasing/lease-acquisition-coordinator.ts:755 isActive check untested — unreachable today; spec line 179 asks for it as a guard
- #455 e2e/helpers/env.ts:248 a startDaemon timeout before activeEnvs.add leaks the daemon — not blocking: only a live daemon that never writes admin.token for 30 s
- #455 e2e/helpers/env.ts:246 the comment's "every later CLI call" is false after SIGKILL (tests lens) — duplicate of the claims finding at env.ts:246, fixed there
- #457 src/daemon/server.test.ts:1043 the comment names a holder that does not exist — duplicate of the comment review finding, fixed there
- #454 src/core/testing.ts:74 doc comment is a what-comment — duplicate of the comment review finding, fixed there

## claims review

- #456 src/gateway/queue.ts:15 `FleetLeaseRecord` doc points at another module — the maintainer accepted it as reviewed
- #456 src/gateway/fleet-coordinator.ts:90 and src/gateway/worker-registry.ts:112 cite an ADR — rule 17 allows ADR citations; both give a why
- #456 docs/internal/COMPONENTS.md:69 says missingApps is committed — it rides the committed transition's event; misleads at most
- #456 docs/CLI.md:549 describes a reclaim the real drivers cannot run yet — the doc states the feature's end state
- #456 docs/CLI.md:818 "not judged against a worker's catalog" — matches the spec's interim wording
- #456 docs/CLI.md:1337 self-contradicting sentence — confusing, but true
- #456 src/mcp/server.ts:126 description omits physical — incomplete, not false
- #456 20 comment findings rejected as giving a why or documenting a client-exported shape (e2e/fake-driver/fake-driver.ts:587, src/cli/index.ts:958, src/contract/operations.ts:171, :181, src/contract/schemas.ts:321, :1049, src/core/domain.ts:24, src/core/driver.ts:113, :115, :326, :357, :364, src/core/reclaim-coordinator.test.ts:290, src/drivers/android/index.ts:910, :1000, src/drivers/ios/index.test.ts:1070, src/gateway/routing/pipeline.ts:31, src/leasing/lease-acquisition-coordinator.ts:142, src/leasing/wait-queue.ts:166, :363)
