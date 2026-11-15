# 0076. An iOS clone names only its own folders before its first boot

- **Status:** Proposed
- **Date:** 2026-11-15
- **Issue:** [#1561](https://github.com/callstackincubator/simlock/issues/1561), bug [#1548](https://github.com/callstackincubator/simlock/issues/1548)
- **Narrows:** [ADR 0061](0061-every-virtual-device-is-a-copy-of-a-source-and-a-baseline-is-a-named-source.md)
  §2's iOS Copy row: one more step before a clone's first boot, beside
  the LaunchServices database drop. §1 (sources in their own set) stands.

Shapes, limits and messages live in the feature's design tables (#1561);
this record holds the decision and why.

## Context

A simulator that has booted stores absolute paths to its own device
folder (`<set>/<udid>`) and its log folder
(`~/Library/Logs/CoreSimulator/<udid>`): in symbolic links, plists and
other files. `simctl clone` copies those bytes, and today a clone changes
only its LaunchServices database before its first boot. A booted copy
then follows its seed's paths and writes into the seed.

Measured 2026-11-15 on Xcode 27.2, iPhone 17, in throwaway sets laid out
as Simlock's (`devices/`, `devices/sources/`):

- A seed booted once names its own UDID in one link (`data/Library/Logs`
  → the seed's log folder), in binary plists (ManagedSettings records,
  Safari's preferences) and in two unified-log `.tracev3` files. The same
  folder is spelled both `/private/tmp/…` and `/tmp/…`.
- Today's flow (iOS 27.2): within 90 s of its boot a copy wrote two files
  into the seed (`data/Library/com.apple.ManagedSettings/Records/…/tokenized.plist`),
  and its `Logs` link pointed at the seed's log folder.
- Rewriting the copy's links and plists from the seed's folders to its own
  before its first boot took 1.0 s; in 120 s after the boot nothing in the
  seed changed, and the copy used its own log folder.

Sources live in their own set (ADR 0061 §1) so that no lease holder's
`simctl` lists them, so a seed's folder and its copy's differ by more than
the UDID: a same-length UDID swap cannot work.

## Decision

TODO after the measurements of 2026-11-15 (iOS 27.0, real use, a baseline
from a used copy, delete against rewrite, cost).

## Consequences

TODO

## Alternatives considered

- **Make seeds beside the copies, then swap UDIDs byte for byte.** Under
  `deviceSet: "default"` the seed would sit in Xcode's own set, listed by
  Xcode, DeviceHub and every `simctl list`, and hit by "Delete All
  Simulators" (ADR 0048). It fixes no seed or baseline made before, whose
  paths differ in length, so the rewrite is needed anyway. Rejected.
- **Make the seed read-only.** A copy that follows a path into the seed
  then fails to write its own state. Rejected.
- **Rewrite one seed→copy pair.** A baseline saved from a copy names two
  other simulators (the seed and the copy it was saved from). Rejected for
  matching by pattern.
