# Stage 06 — Driver interface & fake driver

Goal: the narrow driver contract from ARCHITECTURE.md "Core vs. drivers",
plus a fully controllable fake driver that stages 07–09 use for all core
testing. Real drivers come in stages 11–12 and must fit this interface
without core changes (architecture rule 3).

## Implement

- **`Driver` interface** (in `src/core/`, since the core owns the contract):

  ```ts
  interface Driver {
    readonly platform: Platform;
    resolveSpec(req: DeviceRequest, opts: { allowDownload: boolean }): Promise<DeviceSpec>; // throws RuntimeMissingError
    provision(spec: DeviceSpec): Promise<DriverDevice>;
    makeReady(dev: DriverDevice): Promise<void>; // boot + readiness probe
    reclaim(dev: DriverDevice, opts: { clean: "standard" | "full" }): Promise<"ready" | "shutdown">; // fresh-state strategy
    shutdown(dev: DriverDevice): Promise<void>;
    destroy(dev: DriverDevice): Promise<void>;
    estimate(op: "provision" | "boot" | "reclaim", spec: DeviceSpec): number; // ms
  }
  ```

  `DriverDevice` = `{deviceId, driverData}` — driverData round-trips through
  the registry, opaque to the core. `DeviceRequest` = spec with optional
  osVersion (driver resolves the default = newest installed).

- **Error taxonomy** (typed errors the core switches on):
  `RuntimeMissingError` (→ CLI exit 12), `UnknownModelError` (→ 12),
  `BootTimeoutError`, `DriverCrashError`. Everything else is unexpected.
- **`FakeDriver`** (exported for tests): configurable per-op latency (timers
  on the injected FakeClock, so tests advance time), scripted failures
  (fail Nth provision, hang makeReady until told), call log, and
  deterministic fake driverData. Behaves state-correctly (destroy on an
  unknown device throws).

## Tests first

- FakeDriver honors latency via FakeClock (op resolves only after advance).
- Scripted failure surfaces the right typed error.
- estimate returns the configured values.
- Interface compile-time check: a dummy `const d: Driver = fakeDriver` — the
  contract is the test.

## Watch out

- No warm-pool or snapshot concepts in the interface — `reclaim`'s return
  value ('ready' | 'shutdown') is all the core needs to know.
- `resolveSpec` must be the ONLY place download policy is consulted.
- Do not add driver registry/lookup plumbing beyond a simple
  `Map<Platform, Driver>` — the daemon wires it in stage 09.

## Acceptance criteria

- [ ] Driver interface + typed errors defined in core; no platform imports.
- [ ] FakeDriver controllable for latency/failure/hang and used in its tests.
- [ ] `pnpm check` green.
