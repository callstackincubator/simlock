# v1 implementation stages

Topologically ordered. Each stage assumes every stage above it is committed
and green. Stages 11 and 12 are independent of each other and can run in
parallel; everything else is sequential.

| #   | Stage                                                    | Depends on             | Status  |
| --- | -------------------------------------------------------- | ---------------------- | ------- |
| 01  | [Scaffolding](01-scaffolding.md)                         | —                      | done    |
| 02  | [Ports](02-ports.md)                                     | 01                     | done    |
| 03  | [Event bus](03-event-bus.md)                             | 02                     | done    |
| 04  | [Domain & registry](04-domain-registry.md)               | 03                     | pending |
| 05  | [Config & capacity](05-config-capacity.md)               | 02                     | done    |
| 06  | [Driver interface & fake driver](06-driver-interface.md) | 04                     | pending |
| 07  | [Lease engine](07-lease-engine.md)                       | 04, 05, 06             | pending |
| 08  | [Cleanup reaper](08-cleanup-reaper.md)                   | 07                     | pending |
| 09  | [Daemon & IPC](09-daemon-ipc.md)                         | 07, 08                 | pending |
| 10  | [CLI](10-cli.md)                                         | 09                     | pending |
| 11  | [iOS driver](11-ios-driver.md)                           | 06 (integrates via 09) | pending |
| 12  | [Android driver](12-android-driver.md)                   | 06 (integrates via 09) | pending |
| 13  | [Doctor, nuke & e2e](13-doctor-e2e.md)                   | 10, 11, 12             | pending |

Workflow for implementing a stage: see [../loop.md](../loop.md).
When a stage is completed, flip its Status here to `done` in the same commit.

Binding rules for all stages: [../agent-rules/](../agent-rules/).
Architecture reference: [../ARCHITECTURE.md](../ARCHITECTURE.md).
