# Host load

Does: samples this host's CPU, memory and disk every 15 s and keeps the latest reading.
Entry: `index.ts` → `new HostLoadSampler({ clock, probe, logger })`; `start()`, `current()`, `firstReading()`, `dispose()`.
Uses: ports (`HostLoadProbe`, `Clock`, `Logger`). Never imports: anything else (pinned in `boundary.test.ts`).
Imported by: daemon (`daemon/main.ts`, for a worker and for a gateway).

## How it works

1. `daemon/main.ts` builds the probe: `productionHostLoadProbe` in `ports/host-load.ts`
   (`DarwinHostLoadProbe` on macOS: `os.cpus()`, `sysctl`; `LinuxHostLoadProbe` elsewhere).
   `hostLoadProbe: null` turns sampling off; no sampler, no `load` field.
2. `DaemonServer` calls `start()` at start and `dispose()` at stop.
3. Each tick calls `probe.read()`, bounded at 10 s. One read in flight at a time.
4. CPU busy percent is the delta of two readings' counters; the first reading
   has no `cpu`. A change in core count or `limited` skips one delta.
5. Disk is free and total bytes of the volume holding the data directory.
6. `current()` returns the parts read plus `ageMs`. A failed read records an
   empty reading; a part that stops or starts reading again logs one warning.
7. Readers fit it to the contract with `fitHostLoad` (contract):
   - worker `status.get` → `load` (`daemon/dispatcher.ts`);
   - gateway `status.get` → its own `load` (`gateway/dispatcher.ts`);
   - the gateway's view of a worker carries the `load` from that worker's
     `status.get` (`gateway/worker-registry.ts`); the console shows it.
8. A worker dials its gateway only after `firstReading()`, so the first
   `status.get` the gateway reads has a load.

Linux cgroup v2 (`LinuxHostLoadProbe`): walks `/proc/self/cgroup` up from
`/sys/fs/cgroup`, takes the lowest `cpu.max` and `memory.max`.

- CPU quota below the core count → `cpu.stat` `usage_usec` against that quota, `limited: true`.
- Memory limit below `MemTotal` → `memory.current` minus `inactive_file`,
  against the limit, `limited: true`.
- Otherwise `/proc/stat` and `/proc/meminfo`, `limited: false`.

## State and timers

| What            | Value | Key                         |
| --------------- | ----- | --------------------------- |
| Sample interval | 15 s  | none (`SAMPLE_INTERVAL_MS`) |
| Read bound      | 10 s  | none (`READ_BOUND_MS`)      |

Memory only, nothing persisted. `fitHostLoad` caps `ageMs` at 24 h.

## Rules

- A read never blocks a caller; `current()` returns the last reading or `undefined`.
- A missing part is left out, never zeroed.
- `firstReading()` settles at the first recorded read, whatever it found, or at dispose.
- Tests use `FakeHostLoadProbe` from ports.
