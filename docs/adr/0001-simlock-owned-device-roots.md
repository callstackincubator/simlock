# 0001. Simlock-owned device roots

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issue:** [#73](https://github.com/callstackincubator/simlock/issues/73),
  part of [#70](https://github.com/callstackincubator/simlock/issues/70)
- **Supersedes:** nothing

## Context

Simlock decides whether it may destroy a device by asking the registry. Two
things are wrong with that as the *only* answer.

**Ownership is currently inferred from names.** `Driver.listManaged()` answers
"what is mine" with a prefix match: `device.name.startsWith("simlock-")` on
iOS, `avdName.startsWith("simlock_")` on Android. A user who runs
`avdmanager create avd -n simlock_x` gets adopted silently — `docs/doctor`
already carries a comment admitting this. #73 states the rule plainly: *do not
infer ownership from simulator names.*

**There is a window where a device Simlock created is invisible to Simlock.**
`DeviceProvisioner#provision` calls `driver.provision(spec)` and only then
`registry.registerDevice(...)`. If the registry write fails — or the daemon
dies — the simulator exists on disk with no registry record. Under
"registry-only destruction" Simlock may never touch it again. Every such crash
leaks multiple gigabytes, permanently and silently.

Both problems are the same problem: the registry is being asked two different
questions, and it can only really answer one of them.

> **The registry is the authoritative device *state*. It cannot be the
> authoritative device *inventory*.**

A containment root can answer the inventory question structurally. #73
proposes exactly that for iOS. This ADR adopts it for both platforms, because
the mechanisms differ enough that deciding them separately would produce two
incompatible ownership models in one product.

### What the platforms actually support

Verified against Xcode's `simctl` and `adb` 37.0.1 (Darwin arm64) before
deciding, because the two platforms are *not* symmetric and the asymmetry
drives the design.

**iOS — containment is inherent.** `xcrun simctl --set <path>` scopes every
subcommand. A device in a custom set is absent from the default `simctl list`,
and — the part that matters — it is not addressable at all without the flag:

```
$ xcrun simctl boot   <udid>   → Invalid device or device pair
$ xcrun simctl erase  <udid>   → Invalid device
$ xcrun simctl delete <udid>   → Invalid device
```

CoreSimulator resolves a UDID *within* a set, not globally. Knowing the UDID
buys nothing without the path. No environment variable redirects the default
set (`SIMULATOR_DEVICE_SET_PATH`, `CORESIMULATOR_DEVICE_SET_PATH`,
`SIMCTL_DEVICE_SET_PATH`, `DEVICE_SET_PATH` were all tried and ignored), and
the set is not registered anywhere globally, so nothing discovers it by
accident. Runtimes remain global: a fresh set lists the same runtimes as the
default one, so there is no duplication cost.

**Android — containment must be constructed.** There is no `--set`.
`ANDROID_AVD_HOME` relocates AVD definitions, which hides them from Android
Studio's Device Manager and from a bare `avdmanager list avd` — but a *running*
emulator is just `emulator-5554` on the machine-wide adb server, visible to
anyone and killable with `adb emu kill`. Two further mechanisms close that gap:

- `ADB_LOCAL_TRANSPORT_MAX_PORT` bounds which emulator ports an adb server
  will ever discover (default 5585 — console ports 5554–5584, 16 emulators).
  Measured, with a fake emulator listening at each port:

  | adb server | ceiling | sees `emulator-5556` | sees `emulator-5600` |
  |---|---|---|---|
  | `:5040` | 5555 | no | no |
  | `:5038` | 5585 (default) | yes | **no** |
  | `:5039` | 5683 | yes | **yes** |

- `ADB_USB=0`, `ADB_MDNS=0`, and `ADB_REJECT_KILL_SERVER=1` make a private adb
  server safe to run alongside the user's. From adb's own `client/main.cpp`,
  USB and mDNS initialisation are skipped entirely rather than filtered:

  ```c
  if (!getenv("ADB_USB") || strcmp(getenv("ADB_USB"), "0") != 0) {
      if (is_libusb_enabled()) { libusb::usb_init(); } else { usb_init(); }
  } else {
      adb_notify_device_scan_complete();
  }
  ```

  Confirmed via `adb server-status`: `usb_backend: USB_DISABLED`,
  `mdns_backend: MDNS_DISABLED`, emulators still visible.
  `ADB_REJECT_KILL_SERVER=1` makes `adb kill-server` return
  `error: kill-server rejected by remote server`, so an agent's troubleshooting
  reflex cannot detach every leased device at once.

Unix-domain sockets are **not** available for the adb server on macOS
(`unix:`, `localfilesystem:`, and `localabstract:` all fail), so the private
server must be a TCP port.

Neither mechanism is a security boundary. Anyone who knows the path can pass
`--set`; anyone can raise `ADB_LOCAL_TRANSPORT_MAX_PORT`. They are *accident*
boundaries, and that is the claim this ADR makes.

## Decision

### 1. Every driver owns a device root under `SIMLOCK_HOME`

```
~/.simlock/                                   # SIMLOCK_HOME
├── config.json
├── state.json                                # registry: device state + leases
├── instance.json                             # { instanceId } — written once, never regenerated
├── adb-server.json                           # { pid, port, startedAt } — daemon runtime state
├── daemon.sock
├── daemon.log
└── devices/
    ├── ios/                                  # drivers.ios.deviceRoot → simctl --set
    │   ├── .simlock-owned.json               # ownership marker
    │   └── <UDID>/                           # CoreSimulator's own layout
    │       ├── device.plist
    │       ├── simlock-mark.json             # durable provenance mark
    │       └── data/
    │           └── simlock-mark.json         # erasable provenance mark
    └── android/                              # drivers.android.deviceRoot → ANDROID_AVD_HOME
        ├── .simlock-owned.json               # ownership marker
        ├── simlock_<n>.ini                   # AVD pointer file
        └── simlock_<n>.avd/
            ├── config.ini                    # carries the durable mark key
            ├── simlock-clean-baseline.json
            └── snapshots/
```

Roots hold **device instances only**. Runtimes and system images stay in their
SDK locations: a custom device set already sees every global runtime, and
relocating Android system images would duplicate gigabytes per Simlock home
while fighting `sdkmanager`.

Paths default to `${SIMLOCK_HOME}/devices/<platform>` and are overridable per
platform. Deriving from `SIMLOCK_HOME` gives per-home device isolation for
free, which is one of #73's completion conditions; the override exists because
device data is tens of gigabytes and home directories are not always the right
volume.

### 2. Ownership is proven by a per-root marker

```ts
interface OwnedRootMarker {
  schemaVersion: 1;
  owner: "simlock";
  instanceId: string;
  platform: Platform;
}
```

One marker per root, identical schema across platforms, because roots are
independently configurable and therefore must be independently validated.

Validation is pure filesystem logic — canonicalise the path, refuse a
symlinked root or marker, check owner and permissions, require `instanceId` to
match this instance — so it lives **once** in the platform-agnostic core.
Each driver supplies only its own path. Duplicating these checks per driver
would duplicate exactly the code least tolerable to get wrong.

Roots are created at daemon start, atomically with their marker, and **only**
for a root Simlock itself creates empty. An existing root with a valid,
matching marker is used. An existing unmarked root — empty or not — is
refused. Simlock never adopts and never marks a pre-existing root; "empty
right now" is not proof of "empty when marked". Failing at startup rather than
lazily means validation failures surface at boot, not in the middle of a lease
request.

`instanceId` is a UUID written to `${SIMLOCK_HOME}/instance.json` on first
start and never regenerated. It deliberately does **not** live in
`state.json`: a corrupt registry is precisely the situation in which you would
rebuild, and losing the instance id would strand every device in the root
behind a `wrong-instance` error.

### 3. iOS is scoped with `--set`

Every `simctl` invocation carries `--set <deviceRoot>`. The driver funnels all
of them through one private method, so this is a single insertion point rather
than a per-call-site change. Device-set membership replaces the `simlock-`
prefix as the answer to `listManaged()`.

### 4. Android is scoped with an AVD home *and* a private adb server

Emulator and `avdmanager` invocations carry:

```
ANDROID_AVD_HOME=<deviceRoot>
ANDROID_ADB_SERVER_PORT=<adbServerPort>
```

Simlock starts and supervises its own adb server:

```sh
ADB_USB=0 ADB_MDNS=0 ADB_REJECT_KILL_SERVER=1 \
ADB_LOCAL_TRANSPORT_MAX_PORT=5683 adb -P <adbServerPort> start-server
```

Console ports move to **5586–5682**, above the default 5585 discovery ceiling,
so the user's adb server and Android Studio cannot see, drive, or kill a
Simlock emulator. This also repairs two existing defects: the current range
starts at 5554 and so competes with the user's own emulators, and it extends
to 5682 while the port allocator derives occupancy from `adb devices` — which
cannot report anything above the ceiling, so high ports read as free even when
occupied, and a device that lands on one never becomes visible to the
readiness probe.

If the configured port is occupied, the Android driver **fails closed** with a
typed finding. Silently attaching to whichever server is already listening
could attach to Android Studio's and would erase the guarantee without
producing a single error.

`adb-server.json` records the server's pid because `ADB_REJECT_KILL_SERVER=1`
means the only way to stop it is by pid; a daemon that crashed must find and
reap its own leftover server on restart. It is deliberately not in
`state.json`, so process supervision does not depend on registry integrity.

**Correction (implementation, 2026-09-02).** The command line above is
incomplete, and raising `ADB_LOCAL_TRANSPORT_MAX_PORT` on its own is *worse*
than leaving it alone. The emulator scan's lower bound is hard-coded — there is
no minimum-port variable — so the ceiling only ever widens the sweep upward
from 5555 (`packages/modules/adb`, LineageOS mirror of the AOSP module):

```c
for (int port = DEFAULT_ADB_LOCAL_TRANSPORT_PORT; port <= adb_local_transport_max_port; port += 2)
    connect_emulator(port);   // Note, uses port and port-1
```

A ceiling of 5683 therefore makes Simlock's server scan 5555–5683 and connect
to *the user's own emulators*, leaving two adb servers contending for one
device — the accident this ADR exists to prevent, running in the other
direction. What actually contains it is `ADB_EMU=0`, which skips the scanner
entirely, next to the `ADB_USB` block quoted above in `client/main.cpp`:

```c
if (!getenv("ADB_EMU") || strcmp(getenv("ADB_EMU"), "0") != 0) {
    init_emulator_scanner(StringPrintf("tcp:%d", DEFAULT_ADB_LOCAL_TRANSPORT_PORT));
}
```

`transport_emulator.cpp` corroborates it (`// < DEFAULT_ADB_LOCAL_TRANSPORT_PORT
harmlessly mimics ADB_EMU=0`). Simlock's emulators still attach, because an
emulator announces itself to the server named by `ANDROID_ADB_SERVER_PORT`
rather than waiting to be found (`adb.cpp`):

```c
// Indicates a new emulator instance has started.
if (android::base::ConsumePrefix(&service, "emulator:")) { ... connect_emulator(port); }
```

That path produces a real `emulator-<console>` transport, so `adb emu avd
snapshot …` and `adb emu kill` keep working. The cost, also verified: the
reconnect queue (`retry_ports`, filled by `EmulatorConnection`'s destructor) is
drained only by the scanner thread, so with the scanner off a kicked emulator
is never re-attached automatically. An emulator also announces itself exactly
once, at its own startup, to whichever server existed then — so a clean
`simlock daemon stop`, which reaps that server, would leave every surviving
emulator invisible to the next one: unreportable as an orphan, and sitting on a
console port the allocator would read as free. Simlock therefore sends the same
`host:emulator:<adbPort>` announcement itself, deliberately doing for its own
range what the scanner would do for everyone's: once across the whole console
range (5586–5682) after starting or adopting a server, and again whenever a
serial stays unreachable during a readiness wait. `connect_emulator` is
idempotent, so repeating it is free. Not immediately after spawning an emulator,
though: adb answers the announcement by connecting *out* to that port, which the
emulator has not opened yet.

`ADB_LOCAL_TRANSPORT_MAX_PORT=5683` stays, but not as a bound on the damage —
that reading, in an earlier revision of this paragraph, was backwards. The sweep
starts at the hard-coded 5555, so on a build that ignores `ADB_EMU` the default
ceiling of 5585 already reaches the user's emulators; raising it to 5683 cannot
prevent that and only extends the sweep upward over Simlock's own consoles.
That is what it is for: on such a build it is the only thing that makes
Simlock's own emulators discoverable and re-attachable by a scanner that cannot
be turned off. Where `ADB_EMU=0` is honoured it does nothing in either
direction. Containment is then symmetric — Simlock's consoles sit above the
user's 5585 ceiling so their server cannot see Simlock's emulators, and
`ADB_EMU=0` means Simlock's server never looks at theirs.

The server is also started with `nodaemon server` rather than `start-server`,
so the pid recorded in `adb-server.json` is the server itself and not a
launcher that exits immediately. That record is written as soon as the pid
exists, *before* the port is confirmed to be listening: the window in between
is one a daemon can die in, and a listening server with no record on disk is
the one state nothing automatic can recover — `adb kill-server` is refused by
design and the next start can only report `occupied`. For the same reason the
pid in a record is never signalled on the strength of the pid alone. Its full
command line has to name an `adb` binary, this server's `-P <port>`, and
`nodaemon`; a recycled pid usually belongs to *some* adb, and the machine's
shared server is exactly the wrong thing to SIGKILL. A check that cannot
conclude — no `ps` on the host, a stripped `PATH` — keeps the record rather
than dropping it.

### 5. Containment replaces provenance *inference*, not the registry

`listManaged()` stops matching names and starts reporting root membership.
The `simlock-` / `simlock_` naming stays as a cosmetic label — it is useful in
`adb devices` output and emulator window titles — but carries no authority.

The durable/erasable provenance **marks** stay. They detect a device erased or
deleted out from under a live lease, which containment makes rarer but not
impossible, since a deliberate `--set` still reaches in.

The registry stays, unchanged in role. A directory listing cannot report which
of seven states a device is in, who holds it and until when, how long it has
been idle, when its next quarantine retry is armed, or how many recovery
attempts remain — and deriving any of that from device-set contents would put
`simctl` and AVD knowledge inside the platform-agnostic core.

### 6. Orphans are reported, never automatically destroyed

A device inside a validly-marked root with no registry record is an orphan.
`doctor` reports it (the `orphan-device` / `orphan-process` findings already
exist and become trustworthy once membership replaces prefix matching).
Destroying one requires an explicit `simlock doctor --purge-orphans`.

Automatic reaping was considered and rejected. Every central safety filter —
including the leased-device guard that enforces safety rule 2 — is written
over registry records. An orphan has no record, so orphan proposals would
bypass the entire safety net by construction, and `DeviceOperationClaims` is
keyed by registry device id, so no claim can protect one either. Combined with
the provision-then-register window, an automatic reaper firing mid-provision
would delete a device being provisioned for a live request. Explicit opt-in
keeps marker validation off every unattended destruction path.

`--purge-orphans` is its own flag rather than part of `--fix`, so anyone
already running `doctor --fix` unattended does not acquire a destructive
behaviour on upgrade.

### 7. A lease carries the environment needed to reach its device

Containment cuts both ways: an agent holding a lease cannot reach its device
with bare `simctl` or `adb` either. Drivers therefore return an opaque
`environment: Record<string, string>` with the grant; the core passes it
through without interpreting it; the CLI renders it as shell `export` lines
and in `--json`. iOS contributes its device-set path, Android its adb server
port.

Simlock additionally exposes `simlock simctl` and `simlock adb` passthroughs
that inject the scoping flags, refusing verbs that would mutate device
lifecycle behind the registry's back (`delete`, `erase`, `create`,
`emu kill`) and pointing at `simlock release` / `simlock cleanup` instead.
Without that refusal the wrappers would hand back the exact capability this
ADR exists to remove.

## Consequences

**Good.**

- Ownership becomes structural. #73's "do not infer ownership from simulator
  names" is satisfied by deleting code, not adding it.
- The existing `orphan-device` / `orphan-process` findings become trustworthy,
  and the permanent multi-gigabyte leak from a crash mid-provision becomes
  recoverable.
- No core changes. `Driver.listManaged()` is already the platform-agnostic
  "what is mine" call and already feeds `DoctorFinding`; only its answer
  changes, inside the driver modules. Adding a third driver still requires no
  core edit.
- Two Android port-allocation defects are fixed as a side effect.
- The iOS driver stops *learning* its devices root by parsing `dataPath` out
  of `simctl` output; it reads it from config.
- A Simlock simulator no longer appears in Xcode, and a Simlock emulator no
  longer appears in Android Studio, so accidental interference becomes very
  unlikely.

**Costs.**

- Android gains a supervised child process. Its pid must be tracked, reaped on
  shutdown, and adopted-or-killed after a crash — and `ADB_REJECT_KILL_SERVER`
  means `adb kill-server` will not do it.
- `SIMLOCK_HOME` grows from kilobytes to tens of gigabytes. It must live on a
  local volume with room.
- Startup gains a fail-closed path: a bad marker or an occupied adb port stops
  the affected driver rather than degrading.
- Agents must honour the lease environment, or use the wrappers.
- Existing devices are stranded (see below).
- Two Simlock instances on one machine now need distinct `adbServerPort`
  values. `SIMLOCK_HOME` alone no longer fully isolates them, and the e2e
  helper that runs a real Android driver under a temporary home must set it.

**Migration.** Existing devices are not moved. CoreSimulator has no supported
way to relocate a device between sets, and moving an AVD means rewriting
absolute paths inside its `.ini` and config. Registry entries whose devices
live in the old locations become a typed `doctor` finding whose fix destroys
them through their recorded old path — permitted under registry-only
destruction, since they are in the registry. Users re-provision.

**Not a security boundary.** Restated because it will be misread otherwise: a
user who deliberately passes `--set <path>` or raises
`ADB_LOCAL_TRANSPORT_MAX_PORT` can still reach these devices. This ADR
prevents accidents, not attacks. The provenance marks exist precisely because
deliberate interference remains possible.

## Alternatives considered

**Keep registry-only ownership and accept the leak.** Rejected: it leaves #73
unsatisfied and leaves prefix matching — which silently adopts a user's
`simlock_`-named AVD — in place.

**Drop the registry and derive everything from the roots.** Rejected. Only one
of the registry's responsibilities is ownership; state, leases, idle timers,
quarantine schedules, recovery budgets, capacity accounting, and the wait
queue have no filesystem representation. Deriving them would move `simctl` and
AVD knowledge into the core and make the filesystem a transactional store,
which it is not.

**iOS-only containment (#73 as written).** Rejected as a stopping point: it
would leave two different ownership models in one product, and the Android
half is where name-based adoption actually bites.

**`ANDROID_AVD_HOME` alone, no private adb server.** Rejected once
`ADB_USB=0` and `ADB_MDNS=0` were confirmed to remove the USB and network
contention that was the main objection. Without the private server, running
emulators stay globally visible and Android ownership could never be proven
structurally.

**Automatic orphan reaping.** Rejected — see decision 6.
