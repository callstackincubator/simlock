# Agent rules: architecture

Rules for anyone (human or agent) writing simlock code. Violating these is
grounds for rejecting a change even if it works.

1. **The core is platform-agnostic.** Core modules must never import platform
   code, shell out to `simctl`/`avdmanager`/`adb`/`emulator`, or branch on
   platform. All platform behavior goes through the driver interface
   (`resolveSpec / provision / makeReady / reclaim / shutdown / destroy /
   estimate`).
2. **iOS and Android are encapsulated in their own driver modules.** Nothing
   outside `drivers/ios` may reference simctl concepts (UDIDs are opaque
   strings to the core); nothing outside `drivers/android` may reference
   AVDs, snapshots, adb serials, or ports. This extends to configuration and
   to the lease environment: `drivers.<platform>.*` config entries and the
   `environment` map a driver returns with a grant are **opaque to the core**
   — it stores, merges, and forwards them without interpreting a single key.
   A core module that knows what `deviceRoot` means for iOS, or that
   `ANDROID_ADB_SERVER_PORT` is a port, has leaked.
3. **Adding a driver must require zero core changes.** If a new driver needs
   a core edit, the driver interface has leaked — fix the interface, don't
   special-case the core.
4. **Each distinct functionality is its own module** with an explicit public
   surface: leasing, queueing, registry, capacity, cleanup, event bus,
   drivers, CLI protocol. No cross-module reach-ins to internals — if module
   A needs module B's data, B exposes it deliberately or A subscribes to B's
   events.
5. **Loose coupling via the bus is for observers only.** Transactional flows
   (lease request → queue → provision → ready → grant) are explicit direct
   call chains. Never implement a step of a workflow as an event handler.
6. **The device state machine is the single source of truth.** All state
   transitions go through the core's transition function; drivers and rules
   never mutate device state directly. Do not add platform-specific states.
7. **All destructive operations go through driver verbs** invoked by the core
   (lease path or the cleanup reaper). No module calls `destroy`/`erase`
   ad hoc.
8. **The daemon owns all state; the CLI is a thin client.** No decision logic
   or state caching in the CLI beyond rendering and holding the lease
   connection.
9. **Every external API is accessed through a port interface** (`Filesystem`,
   `ProcessRunner`, `Clock`, `SystemStats`, …) injected at startup — never
   import `fs`/`child_process` or call `Date.now()`/`setTimeout` directly in
   application code. Tests use the in-memory/fake implementations; if a new
   external dependency appears, define its port first. See "External APIs
   behind interfaces" in [../ARCHITECTURE.md](../ARCHITECTURE.md).
10. **A rule is enforced in exactly one place.** Never implement the same
    decision twice — not in two modules, not on two code paths through one
    module, not "once for the fast path and once for the general path". If
    two call sites both have to answer the same question, one of them calls
    the other or they both call a third; whichever shape you pick, deleting
    the duplicate must be part of the change, not a follow-up.

    This is not a style preference. Duplicated enforcement does not stay
    duplicated — it *diverges*, and it diverges silently, because each copy
    keeps passing its own tests. The two copies then answer differently
    depending on which path a caller happened to take, which reads to
    everyone downstream as non-determinism rather than as a bug with an
    address.

    Worked example, from this repo: the gateway's `noWait` rejection was
    enforced both in `FleetLeaseCoordinator#admit`'s direct look and in
    `#dispatch`'s ordered walk. Four consecutive review rounds each found a
    real defect in that loop, and each fix to one path opened a gap in the
    other — a request that answered `NO_CAPACITY` immediately or waited in
    the queue depending on whether *unrelated* requests happened to be
    queued at the time. No single patch closed it; the duplication was the
    defect, and it was only fixed by making one path call the other.

    So when a review finding says "and the same check in the other path
    needs updating too", treat that sentence as the finding. Fix the
    duplication, not the symptom.
