# Implementation stages

These stages describe the next planned changes on top of the completed v1
implementation. They are topologically ordered: a stage may begin only after
every dependency is committed, marked `done`, and `pnpm check` is green.
Stage numbers remain stable when completed stage specifications leave this
active set, so the table may begin above 01.

| #   | Stage                                              | Depends on | Status  |
| --- | -------------------------------------------------- | ---------- | ------- |
| 02  | [Global and platform maxRunning](02-max-running.md) | —          | done    |
| 03  | [Adaptive warm pool](03-warm-pool.md)              | 02         | done    |

The stages are intentionally sequential because they change lease acquisition,
daemon IPC, capacity accounting, and the contention test surface.

Workflow for implementing a stage: see [../LOOP.md](../LOOP.md).

Binding rules for all stages: [../agent-rules/](../agent-rules/).
Architecture reference: [../ARCHITECTURE.md](../ARCHITECTURE.md).
