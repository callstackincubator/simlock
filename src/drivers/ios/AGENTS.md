# iOS driver

Does: simulators in an owned `simctl` device set, slimmed on request, and USB iPhones and iPads through `devicectl`.
Entry: `index.ts` → `IosSimctlDriver.create(options)` (built on macOS only); also `iosPrerequisites`, `IOS_PASSTHROUGH_TOOLS`.
Uses: core, ports, `../installer-process.ts`. Never imports: bus, leasing, daemon.
Parent: [drivers](../AGENTS.md). Flows: [device selection](../../../docs/internal/flows/device-selection.md).

## Files

| File                | Role                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `index.ts`          | `IosSimctlDriver`: every `Driver` verb, slim pass, `simctl` passthrough rules               |
| `physical.ts`       | `IosPhysicalHandler`: enrol, presence, reclaim through `devicectl`                          |
| `devicectl-exec.ts` | `devicectlExecCommand`: the reviewed `devicectl` list                                       |
| `slim-labels.ts`    | `SLIM_CATEGORIES`, `resolveSlimCategories`, `labelsFor`, `slimSignature`                    |
| `prerequisites.ts`  | `iosPrerequisites`: Xcode selected, license accepted, first launch done                     |
| `screen-capture.ts` | `createIosScreenCapture`: runs `vendor/screen-capture/` on a simulator or a physical iPhone |

## How it works

Every simulator command is `xcrun simctl --set <root> …`. Unscoped only: `findLegacy`,
`destroyLegacy`, and the read-only `simctl list -j devices` `listComponents` runs.

Resolve — `resolveSpec` (reads `simctl list -j devicetypes runtimes` on every call):

1. `imageTag` → `UnsupportedRequestOptionError`.
2. Model = device type name, ignoring case; none → `UnknownModelError`.
3. No OS → newest installed runtime that lists the type and is inside its min/max range.
   None → `RuntimeMissingError`, component `latest` or the type's max major.
4. Exact OS outside the range → refused, never downloadable. Installed and paired → spec.
   Installed, not paired → refused. Not installed → `RuntimeMissingError`, component = the version.
   Below iOS 16 is never downloadable.
5. `mode: "slim"` → slim spec only when the runtime is iOS 18.5+; otherwise a full spec.

Provision — `simctl create simlock-<id> <devicetype> <runtime>` → UDID, then the mark:
`<root>/<udid>/data/simlock-mark.json` (erasable) first, then `<root>/<udid>/simlock-mark.json` (durable).

Boot — `makeReady`:

1. `simctl boot`, then `simctl bootstatus -b`, then poll `simctl listapps` until it succeeds.
   Bootstatus and installer polling share one deadline; each probe is capped at 30 s and
   failures retry after 1 s. Deadline expiry → best-effort shutdown, `BootTimeoutError`.
2. Slim pass only for `prepare` + mode `slim` + runtime 18.5+. Too old → skipped, returned `full`.
3. Already slim: `driverData.slimSignature` and `slimMarkToken` match the categories and the
   current mark → return `slim`, no work.
4. Else `simctl spawn <udid> /bin/sh -c` running `launchctl disable system/<label>`, 50 labels a
   chunk. Then shut down and boot again, including the installer check.
5. Commit `slimSignature` + `slimMarkToken` into `driverData`; `onSlimmed` → `device.slimmed`.
   A failed pass → `onSlimSkipped` (logged only); the device keeps the mode it really has.
6. `purpose: "recover"`: boot only, no slim pass.

Reclaim — `reclaim` ignores the clean level: shut down → `simctl erase` → write mark →
`shutdown` / `erase`. The erase removes the slim overrides too.
Physical → `devicectl device uninstall app` for every app not enrolled → `ready` / `uninstall`.
`destroy`: shut down, `simctl delete`. `listManaged`: `simctl list -j devices` in the set, plus marks.

Catalog — models are device type names; class from product family (iPhone `phone`, iPad
`tablet`, Apple Watch `watch`, Apple TV `tv`, Apple Vision `vision`); `modelRuntimes` = paired
installed versions. No aliases, no images.

Components — a component is a runtime version or `latest`.
`installComponent`: `xcodebuild -downloadPlatform iOS [-buildVersion <v>]`, 8 GiB reserved under
`~/Library/Developer/CoreSimulator`. `removeComponent`: `simctl runtime delete <id>`, waits
while it deletes, reports any download left in the asset store as `residue`.
`foreignDevices` counts devices in the default set.

Physical — `devicectl list devices` with `--json-output` to `$SIMLOCK_HOME/devicectl/`
(file deleted after). Id matches identifier, UDID, serial or ECID; wired only.
Refused: simulator, network-only, not iPhone/iPad, below iOS 17, untrusted, Developer Mode
off, locked. Present = listed, paired, unlocked.

Passthrough —

- `simctl`: `xcrun simctl --set <root> …`. Refused: `create`, `erase`, `delete`, `shutdown all`,
  `runtime delete`, any flag before the subcommand (`--set`, `--profiles` named). Refused on a physical lease.
- `devicectl`: physical iOS lease only; no local wrapper. `devicectlExecCommand` allows
  `device install app`, `device uninstall app`, `device process launch|terminate|signal`,
  `device info apps|lockState|details|processes`, each with its own options. Host-path options
  (`--json-output`, `--log-output`, `--destination`, `--file`, `--filter`, `-j`, `-l`) are refused
  before `--`. Adds `--device <udid>` unless the caller names one.

Lease environment: virtual `SIMLOCK_IOS_DEVICE_SET=<root>`; physical `SIMLOCK_DEVICE_UDID=<udid>`.

Screen — `screenCapture` (only when `create` is given a launcher): `simlock-screen-capture
<udid> --codec avcc --fps --bitrate --max-dimension` with `SIMLOCK_IOS_DEVICE_SET=<root>` for a
simulator; a physical iPhone runs `simlock-device-capture` with the same arguments, no such
variable. stdout is the frames, stdin its liveness. Close: stdin, 2 s, SIGKILL. A missing program
→ `ScreenUnavailableError` (the iPhone one refuses iPhone opens only), as does an iPhone below
iOS 27 per the physical handler's `devicectl list devices` (an unreadable version goes on).
Programs: dist/bin from `pnpm build`, or `drivers.ios.screenCaptureCommand` and
`drivers.ios.deviceCaptureCommand`; neither gets `SIMLOCK_COREDEVICE_INFO_PLIST`. The iPhone
program enforces its pin: a CoreDevice major other than 642 exits 69 with the reason, a 503 for
the viewer. Asked to stop while still starting, a program stops and goes inside its 2 s.

Advisories — `runtime-cache-unreclaimable` (asset bundles no installed runtime mounts);
`slim-runtime-unsupported` (installed runtimes below 18.5, only when `ios.defaultMode` is `slim`).

## State and timers

| What                          | Default                     | Key                      |
| ----------------------------- | --------------------------- | ------------------------ |
| Device root                   | `$SIMLOCK_HOME/devices/ios` | `drivers.ios.deviceRoot` |
| Default mode                  | `full`                      | `ios.defaultMode`        |
| Slim categories               | all in `SLIM_CATEGORIES`    | `ios.slim.categories`    |
| Slim boot deadline            | 10 min                      | `ios.slim.bootTimeoutMs` |
| Bootstatus + installer (full) | 120 s                       | none                     |
| Any other `simctl` call       | 30 s                        | none                     |
| Slim chunk                    | 60 s                        | none                     |
| `devicectl` read / uninstall  | 30 s / 60 s                 | none                     |

Writes: the device set (by `simctl`), the two mark files per device. The registry is the only
record of a device's mode; `driverData` holds the slim signature.

## Rules

- Never `simctl` without `--set`, except the three unscoped calls above.
- The erasable mark is written before the durable one, never both at once.
- A recovery boot never slims.
- A slim spec is returned only for a slim request the driver will slim.

## Known gaps

- **A runtime download outlives the runtime (#79).** `simctl runtime delete` leaves its ~8.5 GiB
  asset bundle in `/System/Library/AssetsV2`. Simlock never deletes it; `doctor` and
  `component remove` report it. Reclaim in Xcode → Settings → Platforms.
- **Slim costs (#87, #172).** Every reclaim erases, so the next boot re-slims: two boots each
  time. Below iOS 18.5 a slim request gets `full`. Slim devices lose push, Spotlight,
  StoreKit, universal links, Siri, iCloud sync. Use `--mode full` when a test needs them.
- **Slim drift is invisible.** `launchctl disable` accepts labels that do not exist. Narrowing
  `ios.slim.categories` never re-enables a daemon: reclaim or destroy old devices first.
- **A recovered slim device runs full but its record says `slim` (#174)** until its next `makeReady`.
- **A screen stream can freeze after a reboot under its lease.** The capture program checks the
  simulator is booted only when it starts, then repaints its last surface every 200 ms, so after
  the health monitor reboots a crashed simulator the viewer can see the old picture until they
  press Stop and Show screen again. A lease ending stops it as usual.
- **An iPhone rotated mid-stream keeps the first picture's scale**, as a simulator does today: the
  scaler is sized once, from the first picture. An iPhone that stays connected and unlocked but
  stops sending video, or a decoder that stops producing pictures, shows the last picture until
  the lease ends.
- **A capture killed by SIGKILL cannot stop its CoreDevice stream**; CoreDevice is left to notice
  its client is gone. The same for a stop while `startMediaStream` is still running past 1.5 s.
- **A new Xcode major turns iPhone streams off** until `vendor/screen-capture/Stubs/` is checked
  against that release and the pin moves.
- **Untested on an iPhone:** DeviceHub or Xcode showing the same device during a stream; the lease
  holder's `devicectl` commands during one; the source ending after the first picture; `stop()`
  really stopping the stream. Nothing can observe CoreDevice's state, and a device that serves two
  streams at once lets a new lease stream even after a leaked one, so the slow lane proves only
  that the process is gone and that the device streams again. Two viewers of one lease ask for two
  streams; the two-viewer case finds out whether it serves both (#602 would remove the second).
- **A cold slim lease takes ~160 s.** MCP clients need `resetTimeoutOnProgress` or a longer timeout.
