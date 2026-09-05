# Events

Catalog of business events carried on the daemon's event bus. Naming and
authoring rules live in [agent-rules/events.md](agent-rules/events.md) —
in short: `subject.past-tense-fact`, emitted post-commit, facts not commands.

> Status: **planned catalog** — update the Status column as events are
> implemented, and add new events here in the same change that introduces them.

> **The payload removals in the lease rows are a deliberate exception to
> events rule 6** ("treat payload shape as a public contract: additive
> changes only"), granted by [ADR
> 0004](adr/0004-ttl-first-leases-on-every-transport.md) in its Consequences:
> `lease.granted` loses `mode` and `lease.released` loses the `closed` and
> `orphaned` reasons, since neither concept exists any more — there is no
> connection close to release on, and no startup sweep to orphan anything.
> The ADR takes that exception once, while the package is 0.x; this note
> records it here so the catalogue does not read as a silent rule violation.

## Lease lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `lease.requested` | request spec, requester, wait policy | a lease request is accepted by the daemon | LeaseAcquisitionCoordinator | implemented |
| `lease.queued` | request id, queue position | no capacity; request entered the wait queue | LeaseAcquisitionCoordinator | implemented |
| `lease.granted` | lease id, device id, requester | a device was assigned and handed out | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.renewed` | lease id, new deadline | a `lease.renew` succeeded — whether it came from `simlock lease renew`, `POST /v1/leases/{id}/renew`, or the renew timer a running `simlock lease` / MCP session keeps over its own lease. There is one renew path and this is it | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.released` | lease id, device id, reason (explicit/killed/device-lost), owner id | an explicit `lease.release` (which is what a `simlock lease` holder does on its way out), (killed) an operator `release --all` or `nuke`, or (device-lost) a leased device could not be recovered after it stopped running outside simlock. Closing a connection is not a release and never emits this | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.expired` | lease id, device id, owner id | the lease's deadline passed with no `lease.renew` behind it — the grant-time TTL, or the TTL of the last renew, simply ran out. This is the one way a lease ends without somebody asking, and the only bound on a holder that was killed outright | LeaseLifecycle | implemented (payload per ADR 0004 pending) |
| `lease.rejected` | request spec, reason (timeout/no-wait/unresolvable-spec/already-leased/boot-timeout/killed/cancelled) | a request ended without a grant; `cancelled` is an explicit single-request cancel (`LeaseEngine#cancelPending`, backing `DELETE /v1/lease-requests/{id}`) of a still-queued waiter -- one with device work already in flight is reported `not-cancellable` instead, the same envelope the queue timeout already uses | LeaseAcquisitionCoordinator / WaitQueue | implemented |

## Device lifecycle

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `device.provisioned` | device id, spec, driver, duration | driver `provision` committed to registry | Registry | implemented |
| `device.ready` | device id, boot duration | readiness probe passed | Registry | implemented |
| `device.reclaimed` | device id, strategy (erase/snapshot/wipe), duration | fresh-state reclaim finished | Registry | implemented |
| `device.purge-failed` | device id, lease id, attempted strategy, duration, stable error summary | release-time purge failed; the device enters `quarantined` (see below) rather than rejoining the pool | WarmPoolCoordinator | implemented |
| `device.quarantined` | device id, max retries, next retry deadline | a device committed to `quarantined` — present in the registry, still counted as running, not eligible for a grant. Fires immediately after `device.purge-failed` for a release-time purge failure, or on its own for a stalled-transition timeout (see `device.stalled-transition-detected`) | QuarantineCoordinator | implemented |
| `device.quarantine-recovered` | device id, attempts, reclaim strategy | a quarantined device's retried purge succeeded; it returned to `ready`/`shutdown` and rejoined the warm pool | QuarantineCoordinator | implemented |
| `device.quarantine-abandoned` | device id, attempts | a quarantined device exhausted its configured retry budget (`warmPool.quarantine.maxRetries`) and was destroyed | QuarantineCoordinator | implemented |
| `device.quarantine-stranded` | device id, attempts, stable error summary | a quarantined device exhausted its retry budget and the destroy that should have retired it also failed; it stays `quarantined` with no further retry until an operator intervenes | QuarantineCoordinator | implemented |
| `device.shutdown` | device id, initiator (rule/command) | device stopped, still on disk | Registry; WarmPoolCoordinator for interrupted reclaim recovery | implemented |
| `device.deleted` | device id, initiator | device removed from disk and registry | Registry | implemented |
| `device.foreign-state-detected` | device id, platform, expected (running/stopped), observed (running/stopped) | doctor reconcile found a managed device's observed boot state disagreeing with the committed registry state | Doctor | implemented |
| `device.foreign-provenance-detected` | device id, platform, detail (erased/mark-mismatch/durable-mark-missing) | doctor reconcile found a managed device's provenance marks no longer proving Simlock owns it | Doctor | implemented |
| `device.stalled-transition-detected` | device id, platform, state (provisioning/reclaiming), age, threshold | doctor reconcile found a `provisioning`/`reclaiming` device whose time in that state exceeds a driver-derived threshold (`stalledTransition.thresholdMultiplier` over `Driver.estimate`, floored at `stalledTransition.minimumThresholdMs`) — the driver call meant to resolve the transition never did | Doctor | implemented |
| `device.crash-detected` | device id, lease id, platform, observed | a leased device was observed `stopped` for `health.stableObservations` consecutive ticks | LeaseHealthMonitor | implemented |
| `device.recovered` | device id, lease id, attempts, duration | a crashed leased device was rebooted under its existing lease and passed readiness | LeaseHealthMonitor | implemented |
| `device.recovery-failed` | device id, lease id, attempts, reason, error | recovery could not restore a leased device (absent from driver reality, provenance drift, or attempts exhausted) and its lease was released | LeaseHealthMonitor | implemented |
| `device.orphan-purged` | driver device id, platform, device root | `simlock doctor --purge-orphans` destroyed a device that sat inside a validly-marked Simlock device root with no registry record — see [ADR 0001](adr/0001-simlock-owned-device-roots.md) | Doctor | implemented |
| `device.slimmed` | device id, address, platform (ios), categories, label count, duration, signature, unknown labels | *after* the post-slim reboot's `bootstatus` succeeded -- i.e. once the `launchctl disable` overrides applied via `simctl spawn` are actually in force on the simulator | driver-diagnostics | implemented |

`device.slimmed` reports a fact committed to the *simulator's own launchd database*, not to the
Simlock registry (ADR 0002, `docs/adr/0002-opt-in-slim-ios-simulators.md`) -- so events rule 3 ("emit post-commit
only") is satisfied by waiting for that commit to become observable, not by waiting on a registry
write: the driver applies the `launchctl disable` overrides, reboots the device, and only fires
`onSlimmed` once the second `bootstatus` has passed, proving the overrides survived the reboot and
are actually in force. The registry's own `device.ready` for that same boot is a separate,
later event, emitted through the normal readiness path once the driver call returns. A *skipped*
slim -- the runtime is older than iOS 18.5, its runtime id didn't parse, or the disable pass itself
failed -- is deliberately not an event: it isn't a fact worth putting in front of every event-bus
consumer, just operator diagnostics, so it's a `warn` log line (`daemon.driver-discovery`) instead.

## Components

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `component.install-started` | platform, component id (iOS runtime version or "latest"; Android `sdkmanager` package name), requester id (when the triggering resolution knew one) | a driver is about to run `xcodebuild -downloadPlatform` / `sdkmanager --install` for a missing component, disk preflight already passed | driver-diagnostics | implemented |
| `component.installed` | platform, component id, duration, requester id | the install succeeded **and** a post-install re-scan confirmed the component the request actually needed is present (paired with the requested device type, for iOS) — never fired on a bare exit-0 | driver-diagnostics | implemented |
| `component.install-failed` | platform, component id, duration, stable error summary, requester id | the install failed, including a license-retry failure (exactly one `install-failed` per attempted install, never one per retry), **or** the installer exited 0 but the post-install re-scan could not confirm the component | driver-diagnostics | implemented |

Drivers never touch the event bus directly (architecture rule 5): both drivers report these
facts through their own `onDiagnostic` callback (mirroring the Android driver's pre-existing
diagnostic pattern), and `src/daemon/main.ts` bridges that diagnostic to the bus at driver
construction time — hence the `driver-diagnostics` emitter rather than `IosSimctlDriver` /
`AndroidDriver`. A disk-preflight failure (`InsufficientDiskSpaceError`) happens before any
diagnostic fires: no install was attempted, so nothing is reported as started or failed. See
"Device requests" and "Fresh-state strategy" in [ARCHITECTURE.md](ARCHITECTURE.md) for how a
missing component gets to this point, and `docs/known-pitfalls.md` for the requester-visible
progress gap this leaves.

## System

| Event | Payload (key fields) | Emitted when | Emitter | Status |
|---|---|---|---|---|
| `daemon.started` | version, config snapshot | daemon finished startup + reconcile | DaemonServer | implemented |
| `daemon.stopping` | reason | graceful shutdown began | DaemonServer | implemented |
| `disk.pressure-detected` | free bytes, threshold | free disk crossed under the configured threshold (edge-triggered: once per crossing, not once per tick while it persists) | CleanupReaper | implemented |
| `cleanup.executed` | rule name, action, target, reason | cleanup executor committed a proposed action | CleanupExecutor | implemented |
| `doctor.reconciled` | drift findings | daemon reconciliation completed | Doctor | implemented |
| `driver.root-rejected` | platform, root path, reason (not-absolute/missing-marker/invalid-marker/wrong-instance/symlink/wrong-owner/wrong-permissions/non-empty-unowned-root/unreadable) | a driver's device root failed ownership validation at startup, so that platform's driver did not start | DaemonServer | implemented |
| `driver.adb-server-rejected` | port, reason (occupied/start-failed/invalid-port) | Simlock's own adb server could not be established — the port was occupied by a server it does not own, the server it started never began listening, or the configured port is not usable — so the Android driver did not start | DaemonServer | implemented |

## Conventions recap

- Every event carries: `timestamp`, `event`, `payload`, emitting module.
- Events are appended to a ring buffer that powers `simlock events --follow`
  and serves as the audit trail.
