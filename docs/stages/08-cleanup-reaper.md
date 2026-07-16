# Stage 08 — Cleanup reaper & rules

Goal: "many rules, one reaper" per ARCHITECTURE.md. Rules propose; the
reconciliation loop enforces invariants and executes. Read
agent-rules/safety.md first — invariants live in the loop, never in rules.

## Implement (in `src/core/`)

- **Rule interface**: `{name, evaluate(view: RegistryView): Proposal[]}` —
  pure function; `RegistryView` is a read-only snapshot (devices with states
  - timestamps, active leases, disk free via Filesystem port, config).
    `Proposal` = `{rule, action: 'shutdown' | 'destroy' | 'gc-runtime',
target, reason}` (reason human-readable: "idle 47m > T2=30m").
- **Reaper (reconciliation loop)**:
  collect proposals from all registered rules → dedupe by (target, action;
  destroy supersedes shutdown) → filter through central invariants:
  target is in registry AND not `leased` AND not mid-transition
  (provisioning/reclaiming) AND warm-pool minimums honored (config
  `warmPool`, empty in v1) → execute serially via driver verbs through the
  registry's transition methods → emit `cleanup.executed` per action.
  `run({dryRun: true})` returns surviving proposals without executing.
- **Triggers**: periodic tick (Clock timer, default 60s), plus bus
  subscriptions: `device.released`(→ via lease.released), `daemon.started`,
  `disk.pressure-detected`. Re-entrant runs are coalesced (a run during a
  run schedules one follow-up, not N).
- **v1 rules** (static list, one file each):
  - `idle-shutdown`: `ready`/`warm` device with no lease for > T1 → shutdown.
  - `idle-destroy`: `shutdown` device idle > T2 → destroy.
  - Runtime GC (T3) is explicit-command-only — implement the rule but
    register it in the "manual" list the CLI targets via `cleanup --rule`.

## Tests first

- Each rule as a pure function: given a synthetic RegistryView, proposals
  match expectations at boundary times (idle == T1 → no; > T1 → yes).
- The loop REJECTS a malicious rule's proposal targeting a leased device /
  unknown device (write a deliberately bad rule in the test) — the invariant
  filter is centrally tested, not trusted to rules.
- Dedupe: shutdown+destroy on same target → destroy only.
- dry-run: no driver calls, no state changes, proposals returned.
- Trigger coalescing: 5 events during a run → exactly one follow-up run.
- `cleanup.executed` events carry rule name + reason.
- End-to-end with FakeClock: device released → idles past T1 → shutdown at
  next tick → past T2 → destroyed.

## Watch out

- The reaper uses the SAME driver verbs and registry transitions as the
  lease engine — no parallel destruction path (safety rule 3, architecture
  rule 7).
- A device the reaper is shutting down must not be grabbed by the lease
  engine mid-action: reaper actions go through the engine's decision queue
  (or an equivalent shared serialization) — same linchpin as stage 07.
- Adding a rule = new file + one registration line. Verify that's true by
  how the tests are structured.

## Acceptance criteria

- [ ] Rules are pure; invariants enforced centrally (bad-rule test passes).
- [ ] Tiered idle flow works end-to-end on FakeClock.
- [ ] dry-run is side-effect-free; executed actions attributable
      (rule + reason in the event).
- [ ] `pnpm check` green.
