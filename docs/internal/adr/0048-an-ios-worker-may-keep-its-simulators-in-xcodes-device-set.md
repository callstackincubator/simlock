# 0048. An iOS worker may keep its simulators in Xcode's device set

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-23
- **Issue:** [#962](https://github.com/callstackincubator/simlock/issues/962), from request [#946](https://github.com/callstackincubator/simlock/issues/946)
- **Narrows:** ADR 0001 §1, §2, §3, §5, §6 and §7, for iOS simulators under `drivers.ios.deviceSet: "default"`. Android, physical devices and the `simlock` setting keep ADR 0001 unchanged.

## Context

ADR 0001 puts every Simlock simulator in its own CoreSimulator device set, and every `simctl` call carries `--set <deviceRoot>` (`src/drivers/ios/index.ts:1566` at `3de46d1ff`). Being in the set is what proves a device is Simlock's (`src/drivers/ios/index.ts:726-729`). It is an accident boundary, not a security boundary (`src/drivers/AGENTS.md:44-46`).

The set has a cost ADR 0001 did not weigh. `xcodebuild -destination "platform=iOS Simulator,id=<udid>"` finds a simulator outside Xcode's own set only through the per-user default `DVTSimulatorSetLocation`. This was checked on Xcode 26.4.1, 2026-09-14. Every per-process route fails: a `-DVTSimulatorSetLocation` argument, an environment variable of that name, `HOME` or `CFFIXED_USER_HOME` redirection (with or without `__CFPREFERENCES_AVOID_DAEMON=1`), and `DVT_TOOLCHAIN_USER_DEFAULTS_SUFFIX`. agent-device's XCTest runner passes the argument route (`packages/platform-apple/src/runner/runner-device-set.ts:24-26` at agent-device `v0.21.28`), so it cannot drive a Simlock simulator either. Neither can `react-native run-ios --udid`, Expo `run:ios`, Detox or Maestro. On that Xcode the only route for any of them is to build for `generic/platform=iOS Simulator` and install with `simlock simctl install`.

Xcode 27.0 changed this, checked 2026-10-23 with a simulator in a temporary set: `xcodebuild build -destination "platform=iOS Simulator,id=<udid>"` fails with "Unable to find a device matching the provided destination specifier", and the same command with `-DVTSimulatorSetLocation=<set>` prints `** BUILD SUCCEEDED **`. The argument applies to that one command: `-showdestinations` with it lists only that set's simulators, and no user default is written. agent-device's runner passes the same argument. A tool that lets the caller add `xcodebuild` arguments can then reach Simlock's set. One that runs `xcodebuild` with only its own arguments cannot. Simlock names no minimum Xcode version (`website/src/content/docs/docs/introduction/requirements.mdx:15`).

Android has no such cost: `adb`, Gradle and the React Native CLI honour `ANDROID_ADB_SERVER_PORT`, which the grant exports.

What the set still guards against: `xcrun simctl shutdown all`, `erase all`, `delete unavailable`, Xcode's "Delete All Simulators", and a tool that picks `booted`. What protects a user's own simulators whatever the set: cleanup, `nuke` and the warm pool act only on registry devices (`docs/internal/ARCHITECTURE.md:112-113`). A leased device shut down from outside is rebooted under its lease. A missing one ends its lease as `device-missing` (`src/leasing/lease-health-monitor.ts:216-219`). An erased one ends its lease as `provenance-drift` once it runs again (`src/leasing/lease-health-monitor.ts:238-240`).

Xcode's set belongs to an OS user, and more than one Simlock can run as that user: each `SIMLOCK_HOME` is its own instance with its own `instanceId` (`src/core/AGENTS.md`, Known gaps; the slow lane starts one per run under `/tmp/simlock-slow`, `scripts/slow-e2e.sh:22-25`). The durable mark today holds a token, the UDID and a time, and no instance (`src/drivers/ios/index.ts:1449-1462`).

## Decision

### 1. One driver key chooses the set

`drivers.ios.deviceSet` is `"simlock"` (the default) or `"default"`.

- `simlock`: ADR 0001 as today.
- `default`: Simlock's simulators live in Xcode's set, `~/Library/Developer/CoreSimulator/Devices`, and `simctl` runs without `--set`.

Any other value, or `drivers.ios.deviceRoot` set together with `"default"`, turns iOS off at startup with a `driver.root-rejected` reason `invalid-device-set`. Android keeps running, and `simlock doctor` shows the reason. That is how a bad `deviceRoot` behaves today (`src/daemon/main.ts:1404-1409`). The key is read at daemon start, like every other key.

The per-user `DVTSimulatorSetLocation` default is not a third value, and Simlock never writes it (see Alternatives).

### 2. Under `default`, a device's own mark proves it is this instance's

In Xcode's set, being there proves nothing: the user's own simulators are there, and so may another Simlock instance's. So the mark `provision` and `reclaim` write (`src/drivers/ios/index.ts:741`, `1062`, `1449-1462`) gains this instance's `instanceId`, under both settings. Under `default`, `listManaged` reports only devices whose durable mark names this instance. Any other device (no mark, a mark with no instance, or another instance's mark) is never listed, never an orphan, and never reached by `doctor --purge-orphans`. The root marker of ADR 0001 §2 does not apply to Xcode's set, and Simlock never writes into that folder outside a device it created.

The disk report reads the same rule: a device this instance's mark does not name counts as foreign.

### 3. A changed setting refuses iOS until the operator clears the old devices

At startup the iOS driver looks where the other setting keeps devices:

- under `default`: any device in Simlock's own default set, `${SIMLOCK_HOME}/devices/ios`. A custom `drivers.ios.deviceRoot` is not read: the key is already refused together with `default` (§1), and no registry check looks for it;
- under `simlock`: any device in Xcode's set whose durable mark names this instance.

If it finds one, iOS does not start (`driver.root-rejected`, reason `device-set-changed`). The message names the devices' UDIDs and the steps: set the key back, run `simlock nuke --delete-devices` and `simlock doctor --purge-orphans`, then switch again. An operator who set `drivers.ios.deviceRoot` runs `simlock nuke --delete-devices` and `simlock doctor --purge-orphans` with it still set, and removes it only when switching to `default`. A device those leave behind (nuke deletes only registry devices it could shut down, `src/core/nuke-service.ts:95-150`) is deleted by hand, and the message gives the command: `xcrun simctl --set <root> delete <udid>` under `default`, `xcrun simctl delete <udid>` under `simlock`. Simlock does not move or recreate devices: a switch is rare, and documented operator steps cost less than a migration (the same trade as ADR 0036's upgrade step).

### 4. Under `default`, nothing names a set

The grant carries no `SIMLOCK_IOS_DEVICE_SET`. Neither does the screen-capture program, which then searches Xcode's set (`vendor/screen-capture/Sources/simlock-screen-capture/FrameCapture.swift:417-426`). The agent-device simulator daemon gets no `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET`, so its `simctl` calls and its XCTest runner use Xcode's set (`packages/kernel/src/device.ts:346-348`, `packages/platform-apple/src/runner/runner-device-set.ts:24-25` at `v0.21.28`). A client's own `--ios-simulator-device-set` is still refused.

### 5. `simlock simctl` keeps its refusals

Under `default` the wrapper adds no `--set`, and it still refuses `create`, `erase`, `delete`, `shutdown all`, `runtime delete` and a caller's `--set` or `--profiles`. An agent told to use the wrapper cannot change a device's lifecycle. It can still list, boot, install on or shut down any simulator in Xcode's set by UDID, the user's own included, as it can reach another agent's device today (`src/drivers/AGENTS.md`, Known gaps). Scoping the wrapper to the lease's device is #948. An agent that runs `xcrun simctl` directly is not guarded at all, and the docs say what `shutdown all` does to a leased device.

### 6. When to flip the default

The default stays `simlock`. Flip it to `default` once both of these hold:

- recovery after an external `shutdown all` and an external `erase all` has a slow-lane test;
- the docs have stated for at least one release what those commands do to a leased device.

```mermaid
flowchart LR
  subgraph simlock["deviceSet: simlock (today)"]
    S1[simctl --set root] --> S2[Simlock's set]
    X1[xcodebuild id=UDID] -.not found.-> S2
  end
  subgraph default["deviceSet: default"]
    D1[simctl, no --set] --> D2[Xcode's set]
    X2[xcodebuild id=UDID] --> D2
    D2 --> M{durable mark?}
    M -->|yes| O[Simlock's device]
    M -->|no| U[user's device: never touched]
  end
```

## Consequences

- `src/drivers/ios/AGENTS.md`'s "Never `simctl` without `--set`" holds under `simlock` only.
- Under `default`, a worker's simulators show in Xcode's destination picker and in plain `xcrun simctl list`.
- A careless `xcrun simctl shutdown all` stops leased devices; Simlock reboots each under its lease, and the holder loses running apps. A leased device erased while stopped ends its lease as `provenance-drift` once it runs again.
- Simlock's own background work (cleanup, the warm pool, `nuke`, `doctor --purge-orphans`) never acts on a simulator this instance's mark does not name.
- `driver.root-rejected` gains two reasons, `invalid-device-set` and `device-set-changed`; `docs/internal/EVENTS.md` and the website's cleanup page list them.
- The website gains a "Build and run your app" page. Under `simlock`: the `-DVTSimulatorSetLocation="$SIMLOCK_IOS_DEVICE_SET"` argument on Xcode 27 or later, and the generic build and install on older Xcode or with a tool that takes no extra `xcodebuild` arguments. Under `default`: direct targeting by UDID. On Android: the adb serial.

## Alternatives considered

- **Write `DVTSimulatorSetLocation` for the user.** Rejected by the maintainer on 2026-09-14 and again on 2026-10-23. It applies to every `xcodebuild` run of that user, and it hides the user's own simulators while it is set.
- **No switch: Xcode 27's per-command argument is enough.** Rejected: it does not help older Xcode, or a tool that runs `xcodebuild` with only its own arguments. The docs give the argument as the first route under `simlock`.
- **Make `default` the default now.** Rejected for now: recovery after an external erase has no slow-lane test yet. §6 says when to flip it.
- **Migrate devices when the setting changes.** Rejected: rare, and a lot of code for one switch. §3's refusal and steps are enough.
- **Under `default`, make `simlock simctl` a plain passthrough.** Rejected: agents told to use it would lose their guard for nothing.
- **Prove ownership by the `simlock-` name prefix.** Rejected: a name is cosmetic and anyone can copy it. The durable mark is written only by `provision`.

## Verification

The iOS driver's tests drive both settings with a fake `simctl`: the argv, `listManaged` with marked and unmarked devices, the two refusals, the grant environment, and the passthrough. The agent-device supervisor's tests check the daemon environment. A slow-lane test leases a simulator under `default`, finds it with plain `xcrun simctl list`, and drives it through agent-device.
