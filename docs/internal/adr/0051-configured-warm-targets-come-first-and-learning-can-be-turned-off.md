# 0051. Configured warm targets come first, and learning can be turned off

- **Status:** Accepted
- **Date:** 2026-10-29
- **Issue:** [PR #1009](https://github.com/callstackincubator/simlock/pull/1009)
- **Narrows:** [ADR
  0038](0038-the-warm-pool-learns-its-kinds-from-leases-and-boots-for-every-queued-request.md)
  §3 ("a configured target never displaces (as today)"; configured
  targets and learned kinds filled kind by kind), §8 ("No new config key")
  and its rejected alternative "A `warmPool.learn` key".
- **Narrows:** [ADR
  0017](0017-the-warm-pool-is-a-module-beside-the-lease-transaction.md)
  §5 step 3, which ADR 0038's header kept for configured targets: a target
  never shuts a device down. A configured target now may (§2).

## Context

ADR 0038 fills configured targets in config order, then learned kinds,
and lets only a learned kind displace. A configured target short for a
running slot reports `short` and waits.

On a small worker that wait is long. Kinds leased yesterday are learned
and booted; they hold every running slot, and a configured target stays
short until those kinds go unleased for 24 hours. The same happens to a
configured kind whose learned peak was filled first in an earlier pass,
and to a target behind an idle copy past another target's count. What
the operator wrote down loses to what the pool guessed.

Reported from a gateway fleet in PR #1009, which also asked for a way to
keep only the targets warm.

## Decision

### 1. Every configured count fills before any learned count

Within ADR 0017 §4's budget a pass fills every configured count, in
config order, then the learned counts, newest kind first. A kind both
configured and learned fills its configured count in the first round and
the rest of its learned peak in the second. Reports and `short` reasons
are unchanged; a kind is short by the first round that stopped it.

### 2. A configured count short for a slot may displace

A configured count refused for a running slot or for the reserve takes
the slot of an idle ready device on its platform that no configured count
keeps: a device of a learned kind, or a copy past its own kind's
configured count. Least recently used first; the device is shut down
(initiator `warm-pool`, reason `displaced`) and the target boots or
creates into the slot.

Never displaced: a leased device, one that serves a waiting request, one
a configured count keeps, a device of the short kind itself. No
displacement when the capacity strategy would still refuse the kind with
the device down (as ADR 0038 §3). A learned kind still displaces only an
older learned kind's device, never one a configured count keeps.

### 3. `warmPool.learn`

A boolean, default `true`. `false` plans no learned kinds: only
`warmPool.targets` are kept warm and listed. The pool still records the
kinds it leases, so turning learning back on starts from the last 24
hours. `warmPool.enabled: false` still turns the whole pool off.

## Consequences

- A configured target is met whenever the budget could hold it, at the
  cost of one boot for the kind it displaced when that kind is asked for
  again.
- A worker too small for its learned kinds and its targets can keep only
  the targets, without turning the pool off.
- One more config key; ADR 0038's "zero configuration" stays the default.
- The config schema gains `warmPool.learn`, so the protocol version rises
  by one. `displaced` is already a shutdown reason, and status carries no
  new field.

## Alternatives considered

- **Keep targets from displacing, and only add `warmPool.learn`.**
  Rejected: with learning on, a target still stays short behind
  yesterday's kinds; the operator would have to know to turn learning
  off.
- **Let a target displace for the running limit only, not the reserve.**
  Rejected: a target short for the reserve has the same fix, and the
  displaced device frees the slot the boot would take.
