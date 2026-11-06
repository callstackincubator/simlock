# Host load

Does: samples this host's CPU, memory and disk on a fixed interval and keeps the latest reading.

## Rules

- A read never blocks a caller; `current()` returns the last reading or `undefined`.
- A missing part is left out, never zeroed. A failed read records an empty reading.
- The first reading has no `cpu`: busy percent is the delta of two readings' counters. A change in core count or `limited` skips one delta.
- `firstReading()` settles at the first recorded read, whatever it found, or at dispose. A worker dials its gateway only after it, so the first `status.get` the gateway reads has a load.
- `hostLoadProbe: null` turns sampling off: no sampler, no `load` field.
- Readers fit the reading to the contract with `fitHostLoad`.
- `MemoryPressureTracker` works out the memory pressure step from each recorded reading (ADR 0068).
