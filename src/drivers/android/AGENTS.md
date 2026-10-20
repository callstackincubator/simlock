# Android driver

Does: emulators in an owned AVD home behind Simlock's own adb server, and USB phones on the default adb server.
Entry: `index.ts` → `AndroidDriver.create(options)`; also `androidPrerequisites`, `hostAbiFor`, `ANDROID_PASSTHROUGH_TOOLS`.
Uses: core, ports, `../installer-process.ts`. Never imports: bus, leasing, daemon.
Parent: [drivers](../AGENTS.md). Flows: [device selection](../../../docs/internal/flows/device-selection.md).

## Files

| File                       | Role                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | `AndroidDriver`: every `Driver` verb, console-port allocator, passthrough rules                                                                                       |
| `device-data.ts`           | `androidDeviceDataTable`: owner `android-device-data` version 1, table `android_device_data` (`avd_name`, `config_hash`, nullable `image_identity`, `port`, `serial`) |
| `adb-server.ts`            | `AdbServerSupervisor`: start, adopt, reap Simlock's adb server                                                                                                        |
| `adb-registrar.ts`         | `AdbRegistrar`: announces an emulator (`host:emulator:<adbPort>`)                                                                                                     |
| `screen/`                  | Screen capture: scrcpy client ([screen](screen/AGENTS.md))                                                                                                            |
| `adb-host-protocol.ts`     | adb host-protocol framing (`adbHostRequest`, `OKAY`/`FAIL`), for both callers                                                                                         |
| `default-adb-server.ts`    | `DefaultAdbServerGate`: protocol check of the server on 5037                                                                                                          |
| `physical-handler.ts`      | `AndroidPhysicalHandler`: enrol, presence, reclaim, passthrough for phones                                                                                            |
| `device-profile-source.ts` | `DeviceProfileRegistry`; SDK and devices.xml profile sources                                                                                                          |
| `profiles/index.ts`        | `LibraryDeviceProfileSource`: Simlock's 16 profiles                                                                                                                   |
| `image-fit.ts`             | `fits`, `misfitReason`: which system image a profile takes                                                                                                            |
| `sdk-paths.ts`             | `locateSdk`: SDK root and tool paths, shared with `prerequisites.ts`                                                                                                  |
| `data.ts`                  | `AndroidDriverData`: `avdName`, `configHash`, `imageIdentity`, `port`, `serial`                                                                                       |

## How it works

Start — `AndroidDriver.create`:

1. `locateSdk`: first of `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` with
   `avdmanager` + `sdkmanager` (newest `cmdline-tools/*/bin`, else `tools/bin`), `emulator`,
   `platform-tools/adb`. None → `SdkMissingError`: Android absent, no rejection.
2. `ensureOwnedRoot`: the AVD home, default `$SIMLOCK_HOME/devices/android`.
3. `AdbServerSupervisor.start`. Failure → `AdbServerUnavailableError` → `driver.adb-server-rejected`.
4. Announce every console port 5586–5682 to that server, so emulators that outlived the last daemon reattach.

Every `adb`, `emulator`, `avdmanager` call carries `ANDROID_AVD_HOME=<root>` and `ANDROID_ADB_SERVER_PORT=<port>`.

Simlock's adb server — `adb -P <port> nodaemon server`, env `ADB_EMU=0` (no scanner),
`ADB_USB=0`, `ADB_MDNS=0`, `ADB_REJECT_KILL_SERVER=1`, `ADB_LOCAL_TRANSPORT_MAX_PORT=5683`:

1. Port listening + live record → adopt. Listening, no record → `occupied`.
2. Record alive, port silent → reap. Then spawn, write the record, wait for the port → else `start-failed`.
3. Reap = `ps -o args=` must show `adb`, `-P <port>`, `nodaemon`; SIGTERM, then SIGKILL. Unreadable `ps` keeps the record.
4. `dispose` reaps it. Emulators are spawned unref'd and outlive the daemon.

Provision — `provision`:

1. Profile from the `resolveSpec` cache, else `DeviceProfileRegistry.resolve`.
2. Image: installed, fitting, at the spec's API level. Order: host-ABI `google_apis` → host ABI →
   `google_apis` → any. With an image tag: that tag only, host ABI first.
3. `avdmanager create avd -n simlock_<id> -k <package> -d <seed>`. Seed: the SDK profile's id, else
   the first `avdmanager list device` entry. Then a devices.xml profile writes its `hw.*` keys
   into `config.ini`; a library profile replaces the seed's `hw.*`/`skin.*` keys, sets
   `PlayStore.enabled`, writes `boot.prop`.
4. `configHash` = image path@revision, `emulator -version`, the `config.ini` `hw.*` /
   `image.sysdir.1` / `disk.dataPartition.*` lines, and `headless`/`gpu` when not default.

Boot — `makeReady` (per-device lock):

1. Baseline: stored hash matches → `-snapshot simlock_clean_baseline`; differs → delete
   the snapshots, `-wipe-data`; none → cold boot. Always `-no-snapshot-save`.
2. Console port reserved at the first `prepare` boot in this process: even 5586–5682, not in
   `adb devices`, not reserved, port and port+1 not listening.
3. Ready = `sys.boot_completed` 1, `init.svc.bootanim` stopped or unset, and `adb emu avd path`
   names `<root>/<avd>.avd` (or the same `realpath`), else `DriverCrashError`. Silent serial past 5 s → re-announce.
4. No baseline → `emu avd snapshot save`, check `snapshot list`, write `simlock-clean-baseline.json`, reboot from it.
5. Write the mark: `simlock.mark=<token>` in `config.ini` and `/data/local/tmp/simlock-mark.json`.
6. `purpose: "recover"`: cold boot only. No wipe, no baseline capture.

Reclaim — `reclaim`:

- `full` → shut down; wipe on the next `makeReady`. Returns `shutdown` / `wipe`.
- `standard`, hash still matches → ownership probe (below), then `emu avd snapshot load` → readiness → mark. Returns `ready` / `snapshot`.
- Hash changed or load failed → as `full`.
- Physical → uninstall every user app not on the enrollment list. Returns `ready` / `uninstall`.

Ownership gate: before any `emu kill` or snapshot load, `adb emu avd path` (5 s timeout, asked every time, never cached) must name this device's own AVD directory; unreachable, timed out or another path → nothing is sent (a snapshot reclaim then shuts down and wipes).

`shutdown`: gate, then `adb emu kill`, wait, SIGKILL. `destroy`: kills the emulator this process started, or after a restart each attached
emulator whose bounded `emu avd path` names this AVD (any serial that cannot answer → refuse), then `avdmanager delete avd`, frees the port.
`listManaged`: `<root>/*.avd` + `adb devices` + `ro.boot.qemu.avd_name` per serial; only root members count.

Profiles — library (`profiles/`), SDK (`avdmanager list device`), devices.xml
(`$ANDROID_USER_HOME/devices.xml`, else `.android/devices.xml` under `ANDROID_PREFS_ROOT`, `ANDROID_SDK_HOME`
or home). First case-insensitive name match wins and classes the model by the profile its name resolves to. A
devices.xml name the library shadows → advisory `device-profile-hidden`. SDK class from `Tag`: none `phone`,
`android-tv` `tv`, `android-wear` `watch`, `android-automotive*` `auto`, `android-desktop` `desktop`.

Fit — `fits(profile, image)`: API range, image kind (tag), Play Store, tablet. The catalog's
`modelRuntimes` lists only API levels with a fitting image.

Components — a component is an API level. `installComponent` runs
`sdkmanager --install system-images;android-<api>;google_apis;<hostAbi>`. A license refusal
runs `sdkmanager --licenses` only under `downloads.acceptAndroidLicenses` (false), else
`AndroidLicenseNotAcceptedError`. Reserves 2 GiB on the SDK root. `removeComponent`:
`sdkmanager --uninstall`, refused while an AVD in the user's AVD home names the image.

Physical — port 5037, USB transports only. Before every command `DefaultAdbServerGate.check`:
the 5037 server's protocol must equal Simlock's `adb version`; nothing listening is open.
Mismatch or unreadable → no command, advisory `adb-protocol-mismatch`. Enrol reads model,
`ro.build.version.sdk`, current user, `pm list packages -3`. Class is always `phone`.

Passthrough — virtual: `adb -P <port> …`. Refused: `kill-server` anywhere, `emu kill`,
`emu avd stop`, `emu avd snapshot delete`, any global but `-s`/`-t`/`-d`/`-e` (or a lone
`--version`/`--help`), a bare `shell` with no terminal. Physical: `adb -P 5037 -s <serial> …`;
refuses any leading flag, server and transport verbs, `reboot` to bootloader/recovery/sideload/fastboot.

Lease environment: virtual `ANDROID_ADB_SERVER_PORT=<port>`; physical
`ANDROID_ADB_SERVER_PORT=5037`, `ANDROID_SERIAL=<serial>`.

No slim: `resolveSpec` ignores `mode` and returns a full spec. `fresh` is core's.

Screen — `screenCapture`, only when `create` got `scrcpyServerPath` and `tcpStreamConnector`: [screen](screen/AGENTS.md).

Plain facts: `avdmanager list device` runs on every `listCatalog`, resolve of a model the library lacks,
and library provision (seed); nothing is cached. The sdkmanager catalog is never read. Existing devices are not re-checked for fit.

## State and timers

| What                            | Default                                 | Key                                                             |
| ------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| Device root                     | `$SIMLOCK_HOME/devices/android`         | `drivers.android.deviceRoot`                                    |
| adb server port                 | 5038 (never 5037)                       | `drivers.android.adbServerPort`                                 |
| Emulator flags                  | window, auto GPU, audio, boot animation | `android.emulator.headless`, `.gpu`, `.audio`, `.bootAnimation` |
| Readiness timeout               | 180 s, poll 2 s                         | none                                                            |
| adb server start / stop         | 10 s / SIGTERM, 5 s, SIGKILL            | none                                                            |
| `adb devices` in `listManaged`  | 30 s                                    | none                                                            |
| AVD path query (listing / boot) | 5 s                                     | none                                                            |
| Physical read / uninstall       | 30 s / 60 s                             | none                                                            |

Writes: `<root>/<avd>.avd/` (config, boot properties, snapshots, baseline marker); `$SIMLOCK_HOME/adb-server.json` (`pid`, `port`, `startedAt`).
Reads only: the user's AVD home, devices.xml, the SDK.

## Rules

- Ownership is root membership, proven at boot and in running observations by `emu avd path`, never a name.
- The 5037 server is never started, stopped or adopted on purpose; physical commands pass the gate first.
- A recovery boot never wipes and never captures a baseline.
- A stored port is not trusted after a restart (#52); pinned by `two-instances.test.ts`.

## Known gaps

- **Simlock's adb server is stopped by pid only.** `ADB_REJECT_KILL_SERVER=1` refuses its `kill-server`.
  No record → `occupied`: find it with `lsof`, or move `drivers.android.adbServerPort` (one per instance).
- **A physical command can restart a 5037 server of another protocol (ADR 0022 §5).** One started
  between the gate and the command is restarted by adb's client. Run every adb on the host from one platform-tools.
- **Port checks are partial.** A port handed out but not yet booted reads free to another instance.
- **Android diagnostics are dropped.** `onDiagnostic` (`snapshot-cold-boot`, unreadable
  devices.xml) is not wired in `daemon/main.ts`.
