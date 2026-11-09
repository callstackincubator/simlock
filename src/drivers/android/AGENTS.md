# Android driver

Does: local emulators or AgentDeviceCloud Android devices behind a private adb server, and local USB phones on the default server.
Flows: [device selection](../../../docs/internal/flows/device-selection.md), [drivers](../AGENTS.md), [screen](screen/AGENTS.md), [input](input/AGENTS.md).

## Rules

AgentDeviceCloud:

- Journaled allocations prove ownership, not names. Recovery keeps the lease and ADB port. An API outage is not loss; stopping the worker keeps its leases.

Local containment:

- Ownership is root membership, proven at boot and in running observations by `emu avd path` against the device's own folder, never a name. Every copy's AVD is named `simlock`, so the name is never evidence.
- The gate (`ownership.ts`): before any `emu kill`, `adb emu avd path` must name this device's own AVD folder. It is asked every time, never cached; unreachable, timed out or another path sends nothing.
- Every `adb`, `emulator` and `avdmanager` call carries `ANDROID_AVD_HOME` (the root; a seed's folder while it is made; a copy's own folder at its boot) and `ANDROID_ADB_SERVER_PORT`. Without them a call reaches the user's AVD home and the shared adb server.
- The user's AVD home and devices.xml are only read. The one write is `destroyLegacy`, for an AVD the registry names (safety rule 1).
- A stored port is not trusted after a restart (#52); pinned by `two-instances.test.ts`. A `destroy` after a restart stops each attached emulator whose `emu avd path` names this AVD; a serial that cannot answer refuses the delete, and another path is left alone.
- `listManaged` never lists `<root>/sources/`: a seed is never a device.

Simlock's adb server:

- It runs with the emulator scanner, USB and mDNS off (`ADB_EMU=0`, `ADB_USB=0`, `ADB_MDNS=0`), so nothing attaches unless it is announced. At start the driver announces every console port of its range (`PORT_MIN` to `PORT_MAX` in `console-ports.ts`), so emulators that outlived the last daemon reattach. A serial that stays silent during a boot is announced again.
- `drivers.android.adbServerPort` is never 5037.
- The server is reaped by pid, and only when that pid's command line shows `adb`, `-P <port>` and `nodaemon`. An unreadable command line kills nothing and keeps the record.
- `dispose` leaves the server and its record when `adb devices` still lists an emulator, for the next daemon to adopt: an emulator whose server is gone starts an adb `fork-server` on the port, which the next start refuses as `occupied`. Emulators are spawned unref'd and outlive the daemon.
- A server that cannot start is `AdbServerUnavailableError`: Android is skipped with `driver.adb-server-rejected`. No SDK is `SdkMissingError`: Android is absent, with no rejection.

Seeds and copies (ADR 0061):

- Every device is a copy of its kind's seed, or of the ready baseline source a lease names (`options.source`). A stale baseline source is refused, never copied.
- A seed is never leased or booted after its snapshot save.
- A seed is judged stale on every provision (its system image, the emulator's version, its launch settings), then destroyed and made again. `listSources` reports the reason, which clears when things match.
- One make per kind at a time. `Seeds` takes that lock (`seed:<spec key>`) and the device states from `DeviceTable`, never a lock of its own.
- A `making` row of an earlier process, or one older than any make takes, is swept at the next listing or make of its kind; its emulator is stopped by its path first.
- `removeComponent` destroys the image's seeds after the uninstall; one that fails stays, listed stale.
- The driver counts the user's own AVDs that name an image (`foreignDevices`), and core refuses the removal while there are any.

Boot:

- A copy boots from `simlock_boot`. When the snapshot does not load, the emulator cold-boots the same disk itself: not an error, only the logged diagnostic `snapshot-cold-boot`.
- Never `-wipe-data`, except once for a device made before copies. Always `-no-snapshot-save`. A recovery boot never wipes and never loads a snapshot.
- `-grpc` always goes with `-port`: without it the emulator opens no gRPC endpoint and writes no `avd/running` discovery file. So a console port claims three ports: itself, the adb port above it and the gRPC port (`GRPC_PORT_OFFSET`).
- `-crash-report-mode never` (a stale crash dump otherwise opens a modal dialog that blocks the boot) is passed only when `emulator -help` lists it: emulator 36.1.9 exits on it (#1297), so `androidPrerequisites` does not require it. `never` deletes the dumps in the database the emulator reads, so `ANDROID_EMU_CRASH_REPORTING_DATABASE` names a file in the root, never the user's shared one.
- Ready is more than `sys.boot_completed`: `emu avd path` must name the device's own folder (else `DriverCrashError`), and `pm path android` must answer, since after a snapshot load the boot properties pass before `pm` does.
- No slim: `resolveSpec` ignores `mode`.

Physical phones:

- The 5037 server is never started, stopped or adopted on purpose. Phones are USB transports only.
- Before every command `DefaultAdbServerGate.check`: the 5037 server's protocol must equal Simlock's `adb version`; nothing listening is open. A mismatch or an unreadable answer sends no command and shows as advisory `adb-protocol-mismatch`.

Profiles and components:

- Profile sources are read in order: the library, the SDK (`avdmanager list device`), the user's devices.xml. The first case-insensitive name match wins and classes the model. A devices.xml name the library shadows is advisory `device-profile-hidden`.
- The `avdmanager list device` answer is kept until a file it reads profiles from changes, appears or goes (`AvdmanagerDeviceList`); a failed run is not kept. The sdkmanager catalog is never read.
- Existing devices are not re-checked for fit.
- A component is an API level. A licence refusal runs `sdkmanager --licenses` only under `downloads.acceptAndroidLicenses`, else `AndroidLicenseNotAcceptedError`: licence consent is never implied by download permission.

Tunnels (`device-tcp.ts`):

- `reverse` listens on a free loopback port of the worker's tunnel range (`TUNNEL_PORT_FIRST` to `TUNNEL_PORT_LAST`) and runs `adb reverse --no-rebind` on the device's own server: Simlock's for an emulator, the 5037 one behind the gate for a phone. `cannot rebind existing socket` is `TUNNEL_PORT_IN_USE`.
- `connect` opens the device port through `openDeviceSocket` on the screen's target, with no `adb forward`, so a worker that dies leaves nothing listening.
- `close` removes the rule, then the listener. A removal that fails keeps the listener, which closes every connection at once, until the driver's `destroy` of an emulator or `reclaim` of a phone frees the port (`release`).
- Safety rule 1 on a phone: only the tunnel's own `reverse --remove` at close touches its rules. Its reclaim runs no `reverse --remove-all` and no `forward --remove`; it reads `reverse --list` and frees only the ports no rule points to (a failed read frees none).
- `sweep`, which the daemon calls before any request is served, removes from every present, idle, owned emulator the rules whose host side is in the tunnel range. On a leased emulator, and on any phone, it removes nothing and holds the ports those rules point to. A failed removal is a warning; reclaim and start go on.

## Known gaps

- **Simlock's adb server is stopped by pid only.** `ADB_REJECT_KILL_SERVER=1` refuses its `kill-server`.
  No record → `occupied`: find it with `lsof` (Windows: `Get-NetTCPConnection -LocalPort <port>`; the message names `lsof` only), or move `drivers.android.adbServerPort` (one per instance).
- **A physical command can restart a 5037 server of another protocol (ADR 0022 §5).** One started between the gate and the command is restarted by adb's client. Run every adb on the host from one platform-tools.
- **Port checks are partial.** A port handed out but not yet booted reads free to another instance.
