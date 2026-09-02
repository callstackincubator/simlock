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
  "ios": {
    "slim": {
      "enabled": false,          // default
      "categories": ["..."],     // optional; defaults to every category the driver knows
      "bootTimeoutMs": 600000    // boot deadline while slim is on (see 8)
    }
  }
}
```

`slim` is configuration of the iOS driver, threaded into the driver at
construction. The core never learns which daemons exist or what
"slim" means; it only learns two platform-neutral facts, described in 3
and 6: whether a driver *may* reduce a device (`Driver.reducesFeatures`)
and whether it *did* (`DriverDevice.featureProfile`).

The default is **off** for the first release. It flips to on only once the
label list has been exercised across several runtimes in the wild.

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

The iOS driver's `driverData` gains two fields: `slimSignature`, a hash
over the resolved categories *and* their labels, and `slimMarkToken`, the
device's erasable provenance-mark token as read when slimming was applied.
The second boot is skipped only when both match what is true now. A
differing token is how an intervening `simctl erase` is detected; a
differing signature means the categories or the shipped label list changed.
Either way the pass re-runs. Existing registries without the fields are
treated as "never slimmed"; no migration is needed.

The marker is written only when every chunk of the disable pass actually
ran. A chunk that failed to run leaves the marker unwritten so the whole
set is retried on the next boot; a label the simulator itself rejected is
recorded and does not block the marker, so a runtime with one renamed
daemon converges in a single boot instead of re-applying forever.

Alongside the driver's private data, `DriverDevice` and `DeviceRecord`
carry a platform-neutral `featureProfile: "full" | "reduced"`. It is set on
every readiness transition, so a stale `"reduced"` can never outlive a boot
that did not slim. This is what the lease response's `slim` flag (6) is
derived from, without the core reading opaque driver data.

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

`simlock lease --full` (MCP `full: true`, HTTP `full: true`) requests a
device without the slim pass. The lease response always carries
`slim: true | false`, so an agent whose StoreKit test fails on a slim device
sees a greppable reason rather than an inexplicable timeout.

Full and slim devices are kept apart through spec identity. `DeviceSpec`
gains an optional `full: true`, and `sameSpec` compares it (with `undefined`
equal to `false`, so existing registries keep matching). The core stamps it
in exactly one place, when `LeaseAcquisitionCoordinator` resolves a spec,
and only when the resolving driver declares `reducesFeatures`, which the iOS
driver does only while slim is enabled. A driver that never reduces
anything, such as Android, therefore never sees its pool split. A `--full`
request never receives a slim device; it waits or triggers provisioning like
any other pool miss.

Crash recovery is the one path that reboots a leased device. It calls
`makeReady` with `purpose: "recover"`, and the iOS driver treats that as a
plain boot with no slim pass and no second reboot. Safety rule 2's
recovery exception grants a reboot and nothing more.

### 7. An unknown label is never a boot failure

Apple renames and retires daemons between runtimes. `launchctl disable` on
a label that does not exist is logged and skipped; the pass continues and
`makeReady` succeeds. The label list is versioned per iOS major so the
mismatch stays small, but a slim pass that bricks provisioning is strictly
worse than no slim pass.

### 8. The boot deadline accounts for the second boot

`ios.slim.bootTimeoutMs` (default ten minutes, matching simslim on CI
runners) replaces the ordinary `bootstatus` deadline, but only for a boot
that will actually slim: a `--full` device, a runtime below the floor, or a
recovery boot keeps the normal deadline. `Driver.estimate` quotes the
double-boot cost for the same boots so `doctor` does not read a slim boot
as a stalled transition.

### 9. The event is reported by the driver, after the reboot proves it

`device.slimmed` is bridged from the driver's `onSlimmed` callback in the
daemon, exactly like `component.install-*`, and fires only once the
post-slim `bootstatus` has passed. The fact it reports is committed to the
simulator's launchd database, not the registry, which is why the bridge
does not wait on a registry write. A skipped or failed slim is a warning
log line, not an event.

### 10. Failure degrades to "not slimmed", never to a failed lease

A failed disable pass, a shutdown that times out, or a hiccup in the slim
reboot all return the device as-is with an honest `featureProfile`
(conservatively `"reduced"` when the driver cannot tell), and the lease
proceeds. Only a genuine inability to bring the device back up propagates.

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
  from being a slow leak of memory savings. Re-syncing the list changes the
  signature and re-slims every device on its next boot, which is intended.
- **No `launchctl enable` pass.** Narrowing `categories` re-applies the
  narrower set but never re-enables what the wider set disabled. Devices
  slimmed under the old list must be reclaimed before the change is trusted.
- **Turning slim off strands `--full` devices.** Once `reducesFeatures` is
  false no new spec carries `full: true`, so devices provisioned for a
  `--full` request match nothing until the idle cleanup rules reap them.

**Safety review.** Compatible with every invariant in
`docs/agent-rules/safety.md`: registry-only targets, never a leased device,
no downloads, destruction only through the existing `erase` path, every pass
attributable through `device.slimmed`.

## Alternatives considered

**Make the slim *configuration* part of `DeviceSpec`.** Rejected. It would
put a driver implementation detail into spec identity and split every pool
in two for a property the core has no reason to know about. Only the
platform-neutral `full` opt-out is in spec identity, and only when a driver
declares it can reduce anything, so a platform that never reduces is never
fragmented.

**Let the driver derive the pool key itself.** Rejected. Pool matching lives
in the core, and a driver-owned key would need a new concept in the driver
interface for one flag. Stamping `full` centrally, gated by
`reducesFeatures`, keeps drivers unaware of request flags (architecture
rule 3) with a two-line change.

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
