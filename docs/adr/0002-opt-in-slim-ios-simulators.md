# 0002. Opt-in slim iOS simulators

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issue:** [#87](https://github.com/callstackincubator/simlock/issues/87)
- **Supersedes:** nothing

## Context

Simlock exists to pack as many leased devices onto one machine as possible.
A stock iOS simulator idles at roughly 4 GB physical footprint across about
260 processes. On a 16 GB Mac that caps the fleet at four devices, and
memory — not CPU or disk — is what ends the scaling curve.

Almost none of that footprint serves a test run. It is Siri, Spotlight,
iCloud, the App Store, Mail, Safari, Photos, News, Weather, Maps, Family
Sharing, Health, Home, messaging, and telemetry daemons that launchd starts
on every boot because a real phone would want them.

[simslim](https://github.com/mobai-app/simslim) demonstrates the fix. It
writes persistent `launchctl disable` entries for a curated list of launchd
labels into the simulator's *own* launchd database, via
`simctl spawn <udid> launchctl ...`, then reboots. Measured on one simulator:

| | stock | slim |
|---|---|---|
| processes | 258 | 70 |
| phys_footprint | 4.0 GB | 0.9 GB |

Two properties of the mechanism drive this ADR:

- **The overrides live inside the device's data partition.** Nothing on the
  host changes. `simctl erase` wipes them along with everything else.
- **Persistence needs iOS 18.5 or newer.** Older runtimes accept the
  `launchctl disable` commands and then forget them at the next boot.

The savings are not free. A slim device loses push notifications, Spotlight,
StoreKit, universal links, and some system pickers. Some test suites need
those, so slim cannot be the only mode.

## Decision

### 1. Slim mode is a driver-level, opt-in setting

```jsonc
{
  "drivers": {
    "ios": {
      "slim": {
        "enabled": false,          // default
        "categories": ["..."]      // optional; defaults to the full curated list
      }
    }
  }
}
```

`slim` is configuration of the iOS driver, not a field of `DeviceSpec`. Spec
identity stays `{ platform, model, osVersion }`, so the warm pool, the
acquisition planner, and the capacity policy are unchanged. The core never
learns that slimming exists.

The default is **off** for the first release. It flips to on only once the
label list has been exercised across several runtimes in the wild.

### 2. Slimming happens inside `makeReady`, and nowhere else

After `simctl boot` and `simctl bootstatus -b` succeed, and only when slim
is enabled, the driver:

1. applies the disable list through `simctl spawn <udid> launchctl disable`,
2. shuts the device down,
3. boots it again and waits for `bootstatus -b`,
4. records what it did in `driverData` (see 3),
5. emits `device.slimmed` after the registry commit.

`makeReady` is the single choke point because it is the only operation that
already holds the safety guarantees this needs: it runs on registry-owned
devices, it never runs on a leased device (the crash-recovery exception in
`ManagedDeviceLifecycle.recoverLeased` reboots an already-provisioned device
and is precisely the case where re-slimming is correct), and it downloads
nothing. Slimming from a cleanup rule, from `doctor`, or from the CLI
directly would each have to re-derive those guarantees.

### 3. The pass is idempotent and self-describing

`driverData` gains:

```ts
{
  slim?: {
    applied: true;
    labelSetHash: string;   // hash of the exact labels disabled
    runtime: string;        // iOS version the labels were chosen for
  }
}
```

The second boot is skipped when the stored hash matches the hash of the
labels the current config would produce *and* the device has not been erased
since. A config change to `categories` changes the hash and forces a re-pass
on the next `makeReady`. Existing registries without the field are treated as
"never slimmed"; no migration is needed.

### 4. Runtimes older than iOS 18.5 are skipped with a warning

The overrides do not persist there, so a pass would cost a boot and buy
nothing. The driver compares the runtime version numerically (not
lexically — `26.0` is newer than `18.5`), skips the pass, logs a warning,
and `doctor` reports the mismatch between config and runtime.

### 5. The warm pool absorbs the cost

Slimming doubles the boot work. Warm-pool provisioning and reclaim both run
off the request path, so with a pool of at least one device per spec the
lease-time cost stays at one boot. Cold acquisitions pay the second boot
once; the user opted in.

### 6. A lease can ask for a full device

`simlock acquire --full` (MCP `full: true`, HTTP `full: true`) requests a
device without the slim pass. The lease response always carries
`slim: true | false`, so an agent whose StoreKit test fails on a slim device
sees a greppable reason rather than an inexplicable timeout.

Full and slim devices under the same spec are kept apart by a pool key that
includes the mode. A `--full` request never receives a slim device; it waits
or triggers provisioning like any other pool miss.

### 7. An unknown label is never a boot failure

Apple renames and retires daemons between runtimes. `launchctl disable` on
a label that does not exist is logged and skipped; the pass continues and
`makeReady` succeeds. The label list is versioned per iOS major so the
mismatch stays small, but a slim pass that bricks provisioning is strictly
worse than no slim pass.

### 8. The boot deadline accounts for the second boot

`BootTimeoutError` thresholds are raised when slim is on. simslim uses a
ten-minute deadline on CI runners; the driver adopts a comparable budget for
the combined boot–slim–reboot sequence rather than for each boot separately.

## Consequences

**Good.**

- Roughly four times the iOS devices per machine. This is the core value of
  the product, and no other backlog item moves the number.
- No host modification. Every change lives inside the simulator's data
  partition, and `erase` — which reclaim already performs — is the complete
  undo.
- No core change. The driver interface, registry schema, and safety filters
  are untouched; `driverData` was already opaque to the core.
- Fully compatible with [0001](0001-simlock-owned-device-roots.md): `simctl
  spawn` is just another `simctl` call and takes `--set` like the rest.

**Costs.**

- **Every lease cycle costs two boots.** `IosDriver.reclaim` always runs
  `simctl erase`, which wipes the overrides, so every reclaimed device is
  re-slimmed. Accepted because reclaim runs off the critical path. A
  non-erasing `standard` clean would remove the cost and is left for a later
  ADR.
- **Feature loss is real and silent at the API level.** Push, Spotlight,
  StoreKit, universal links, and some pickers stop working. Mitigated by
  `--full`, the `slim` flag in the lease response, and a documented list in
  `known-pitfalls.md`.
- **Pool fragmentation.** Mixing modes under one spec means a `--full`
  request may wait behind slim devices or force provisioning.
- **Runtimes older than 18.5 gain nothing.** The version gate makes this
  visible rather than fixing it.
- **A maintained label list.** Apple's daemon set drifts; the list needs a
  refresh per iOS major. Decision 7 keeps drift from being a failure, but not
  from being a slow leak of memory savings.

**Safety review.** Compatible with every invariant in
`docs/agent-rules/safety.md`: registry-only targets, never a leased device,
no downloads, destruction only through the existing `erase` path, every pass
attributable through `device.slimmed`.

## Alternatives considered

**Make slim part of `DeviceSpec`.** Rejected. It would put a driver
implementation detail into spec identity and split every pool, capacity
estimate, and catalog entry in two for a property the core has no reason to
know about. A pool key derived by the driver achieves the separation without
leaking the concept.

**Slim at provision time only, never on reboot.** Rejected. Overrides do not
survive `erase`, so a provision-only pass would leave every reclaimed device
stock again. `makeReady` is the only hook that runs after every erase.

**Avoid the double boot by skipping `erase` on reclaim.** Deferred, not
rejected. It changes the reclaim contract for every consumer and deserves
its own ADR once slim mode has shipped and the real cost is measured.

**Default on.** Rejected for the first release. Feature loss is silent for
callers who have not read the docs, and the label list has not yet been
exercised across runtimes. Revisit once both are true.

**Trim via `simctl` device-type overrides or a custom runtime.** Rejected.
No supported mechanism exists; simslim's approach is the only one that
survives reboots on stock runtimes.
