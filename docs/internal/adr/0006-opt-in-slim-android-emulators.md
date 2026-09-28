# 0006. Opt-in slim Android emulators

- **Status:** Proposed
- **Date:** 2026-09-28
- **Issue:** [#159](https://github.com/callstackincubator/simlock/issues/159)
- **Supersedes:** nothing

## Context

[0002](0002-opt-in-slim-ios-simulators.md) made slim mode an iOS driver
setting and taught the core two platform-neutral facts: a driver may reduce
a device (`Driver.reducesFeatures`) and a boot did reduce it
(`DriverDevice.featureProfile`). Android has neither. An emulator boots with
the guest RAM its device profile asks for and with every package its system
image ships, and the `resource` capacity strategy budgets 4 GiB for each one.

Two things make an Android emulator heavy, and they are fixed at different
moments:

- **Guest RAM.** The emulator takes `-memory <MiB>` at launch, overriding the
  AVD's `hw.ramSize`, and `-lowram` boots the guest as a low-RAM device,
  which is where most of the saving comes from. Both are per-boot flags;
  nothing on disk changes.
- **Background packages.** `pm disable-user --user 0 <package>` takes effect
  at once, needs no reboot and no root, and persists in the data partition.
  A wipe undoes it; a snapshot carries it.

Reported on one Pixel profile with a hardware GPU, 1536 MiB of guest RAM and
about seventy packages disabled: host footprint drops from roughly 8.5 GB to
roughly 2.5 GB.

The Android driver already has the persistence mechanism this needs. Its
first boot captures a clean-baseline snapshot, later boots and every
`standard` reclaim restore it, and a hash over the inputs the baseline
depends on decides when it is rebuilt.

The maintainer decided the scope in #159: RAM size and low-RAM mode, each
its own key; packages in categories with Play Store, Chrome and the setup
wizard in a category that is off unless named; no guest settings; no
automatic capacity change.

## Decision

### 1. Slim mode is a driver-level, opt-in setting

```jsonc
{
  "android": {
    "slim": {
      "enabled": false,      // default
      "ramMb": 1536,         // guest RAM for a slim device, in MiB
      "lowRam": true,        // boot the guest as a low-RAM device
      "categories": ["..."]  // optional; omitted means every default category
    }
  }
}
```

The block reaches the driver at construction, next to `android.emulator`
from #148. The core validates types and forwards it unread. No lease
request, MCP call or HTTP request can set any of it. The driver declares
`reducesFeatures` exactly when `enabled` is true, and 0002's decision 6
(`--full`, spec identity, `featureProfile`) applies unchanged. Every key
applies at a device's next boot.

### 2. Two mechanisms, one boot

For a device that is not `full`, when slim is enabled:

1. every launch adds `-memory <ramMb>` and, when `lowRam` is true, `-lowram`;
2. on a boot that will capture the clean baseline, after `sys.boot_completed`
   and before the capture, the driver disables the resolved package set.

There is no second boot. The launch flags are part of every boot of the
device, including a recovery boot, because they describe what the device
is, not a pass that changes it. The package pass runs only on a
baseline-capturing `prepare` boot, never on `recover` (safety rule 2) and
never on a boot that restores the baseline, because that baseline already
carries the result.

### 3. The clean baseline is the idempotence marker

The baseline config hash gains the slim inputs that apply to this device:
`ramMb`, `lowRam`, and the signature of the resolved categories and their
packages. A baseline captured under a hash is slim by construction. A
changed key, a changed shipped list, or a `full` reclaim all lead to the
same place: the hash no longer matches, the driver wipes, boots, runs the
pass, and captures again. No per-device marker like 0002's `slimSignature`
is needed, and no migration: a registry from before this ADR has no slim
inputs in its hash and rebuilds once.

A `full` device contributes no slim inputs, so its hash equals the hash the
driver computed before slim existed and a baseline captured then stays
valid for it.

### 4. `full` is stamped at provision

`AndroidDriverData` gains `full?: true`, written by `provision` from
`DeviceSpec.full` exactly as the iOS driver does. `makeReady` reads it from
driver data alone, so a `--full` device gets no launch flags, no pass, and
`featureProfile: "full"`. Data without the field is not full. Driver data
recovered from a running emulator (`configHash: "recovered"`) is not full
either; the next baseline check settles it.

### 5. The profile is derived, not observed

`featureProfile` is `undefined` while slim is off, `"full"` for a `full`
device, and `"reduced"` otherwise, on every boot including recovery. It
does not depend on whether the package pass ran this boot: on a slim device
the launch flags always applied, and a restored baseline already holds the
package state.

### 6. Failure degrades to an uncaptured baseline, never to a failed lease

If the pass cannot run to completion (adb refuses, a command times out),
the driver logs a warning, skips the baseline capture, and returns the
device with `featureProfile: "reduced"`. The lease proceeds. The next
`prepare` boot finds no baseline and tries again. Only a genuine boot
failure propagates.

A package the image does not carry is not a failure: the driver lists
installed packages first, skips what is absent, and reports it. A package
that is present but that `pm` refuses to disable is reported the same way
and does not block the capture, so a list that drifts by one package on a
new API level converges in one boot.

### 7. The shipped list never contains a package the guest cannot live without

The package data file is versioned data next to the driver, grouped into
named categories with a `default` flag; `categories` omitted means every
category whose flag is true. Play Store, Chrome and the setup wizard form
the one category that is false. A denylist in the same file, enforced by a
unit test over every category, keeps out Google Play Services and its
framework, the Bluetooth package (system_server crash-loops on recent
releases when it is disabled), WebView, and core system packages. Every
package name must match `^[A-Za-z0-9_.]+$` before it reaches a shell
(safety rule 10).

### 8. Every wait in the pass is bounded

Each `pm` call runs under the driver's command timeout, and the whole pass
has its own budget measured from its start. `Driver.estimate` for a `boot`
adds that budget when slim is on and the spec is not `full`, so `doctor`
does not read a slimming boot as a stalled transition.

### 9. Images that ignore the RAM size are an advisory, not a failure

System images with 16 KiB pages (tag `*_ps16k`) enforce a 4 GiB floor in
the emulator and gain nothing from `ramMb` below it. `advisories()` reports
one `slim-image-ram-floor` advisory naming such installed images while slim
is on and `ramMb` is below the floor. The boot itself is not gated.

### 10. The event is `device.slimmed`, with a package as the label

The daemon bridges the driver's `onSlimmed` callback to `device.slimmed`
with `platform: "android"`, the same payload shape as iOS: `categories`,
`labelCount`, `signature`, `unknownLabels`, `durationMs`. On Android a label
is a package name. The fact is committed to the guest's package state, and
the driver fires it only after reading the disabled list back and before
the capture. Additive to the payload contract, so existing consumers keep
parsing.

## Consequences

**Good.**

- One boot per lease cycle, and a `standard` reclaim keeps a device slim at
  no cost. This is cheaper than iOS, where every reclaim erases and
  re-slims.
- No core change. `reducesFeatures`, `featureProfile`, `DeviceSpec.full` and
  the pool split already exist.
- No host change and no new dependency: `emulator` and `adb`, which the
  driver already runs, and no root in the guest.
- The baseline hash is one mechanism for three concerns: persistence,
  idempotence, and config change.

**Costs.**

- **Every slim config change wipes each device once.** Changing `ramMb`,
  `lowRam`, `categories`, or the shipped list invalidates the baseline, and
  the next boot is a wipe plus a full cold boot plus the pass. Accepted:
  that is what a config change means for the baseline today, and it runs
  off the request path for warm devices.
- **Low-RAM mode is app-visible.** The guest reports itself as a low-RAM
  device and multi-window is off. `lowRam: false` keeps the RAM saving
  without it, and `--full` opts a lease out of everything.
- **Feature loss is real.** Whatever a category disables stops working.
  `--full` and `featureProfile` are the mitigations, and `KNOWN-PITFALLS.md`
  lists what to expect.
- **Pool fragmentation** under one spec, as in 0002.
- **A maintained list.** Google renames and adds packages per API level.
  Decision 6 keeps drift from being a failure; a list refresh changes the
  signature and rebuilds every baseline once.
- **The capacity budget is not derived.** An operator who turns slim on and
  leaves `ramBudget.androidBytesPerDevice` at 4 GiB gets no extra devices.
  The docs say what to pair.
- **`-lowram` is verified in delivery.** The flag and its effect
  (`ro.config.low_ram` true in the guest) are checked by the slow e2e lane,
  not assumed.

**Safety review.** Compatible with every invariant in
`docs/internal/agent-rules/safety.md`: registry-only targets, never a leased
device, no downloads, destruction only through the existing wipe path, no
root, shell input validated, every pass attributable through
`device.slimmed`.

## Alternatives considered

**Write `hw.ramSize` into `config.ini`.** Rejected. It clobbers the device
profile's own value, and a `full` device would need it written back. A
launch flag leaves the AVD as the profile defined it and makes full versus
slim a per-boot decision from driver data.

**A per-device marker, as in 0002.** Rejected. The baseline hash already
answers "is this device's persisted state the one the config asks for", and
a second answer would diverge from it (architecture rule 10).

**Disable packages on every boot.** Rejected. A restored baseline already
carries the state; re-running the pass would cost a minute per boot for
nothing and turn a missing package into a per-boot warning.

**`pm uninstall --user 0` instead of disable.** Rejected. Harder to reason
about across API levels, and no gain: both persist in the data partition
and both are undone by a wipe.

**Guest settings (animations, background process cap, sync, location).**
Deferred by the maintainer. They would ride the same pass and the same
baseline, and can be a later category without touching this design.

**Derive the capacity budget from slim.** Rejected. Capacity is core and
platform-neutral; a driver setting steering it would breach architecture
rule 2. The operator sets the budget.
