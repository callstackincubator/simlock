# 0006. Events and the daemon log are two records

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-01
- **Issue:** [#168](https://github.com/callstackincubator/simlock/issues/168),
  [#169](https://github.com/callstackincubator/simlock/issues/169)
- **Supersedes:** nothing

## Context

The daemon produces two kinds of output.

The **event bus** carries business facts: `lease.granted`,
`device.crash-detected`, `worker.connected`. Each one is named, documented in
`EVENTS.md`, emitted only after the state change it describes is committed,
and has a payload that changes additively only. Events reach agents and
operators through `simlock events`, the HTTP API, and a gateway's relay. They
live in an in-memory ring buffer of 1000 entries.

The **`Logger` port** carries operational lines: startup, driver discovery,
connection churn, errors. They go to `daemon.log` as JSON lines, rotated by
size. Their wording and fields carry no contract.

Neither answers "what happened to this lease or device" after the fact. The
ring is empty after a restart and overwritten within minutes on a busy
gateway. `daemon.log` survives a restart but records two events only, copied
there by hand. It also records no socket request and drops the error of most
background failures.

The obvious repair is to merge the two: one stream, saved as `daemon.log`,
with a filter deciding what `simlock events` shows. This record says why that
is not what Simlock does, and what it does instead.

## Decision

### 1. Two records, two producers

The event bus and the `Logger` stay separate. Neither is built on the other.
An event is a fact about state Simlock owns. A log line is a diagnostic about
what the daemon was asked to do and what went wrong while doing it.

### 2. Every event is persisted, in a file of its own

One bus subscriber writes every event envelope, unchanged, to `events.jsonl`
in the data directory. The file has its own size limit
(`eventLog.rotateBytes`) and rotates on its own. Log lines cannot rotate
events out, and events cannot rotate log lines out.

Which events are worth keeping is not decided per event. The one left out is
the one that is needed later.

### 3. A fact is never repeated in the daemon log

`daemon.log` does not record that a lease was granted or a device was
reclaimed. The event file does. A background failure whose error text already
travels on an event (`device.purge-failed`, `device.recovery-failed`) is not
logged a second time.

The two existing copies, `component.installed` and `device.slimmed`, are
removed from `daemon.log`.

### 4. A log line never becomes an event

When something must be visible to agents or operators as a fact, it gets a
real event: a `subject.past-tense-fact` name, a documented payload, and
post-commit emission. Promoting a log line onto the bus, or adding an
"internal" class of event that a filter hides, is not allowed.

### 5. The contract follows the record

A line in `events.jsonl` is the event envelope, so it is under the event
payload contract: additive changes only. A line in `daemon.log` is under no
contract. Its message and fields may change in any release.

### 6. Each reader shows one record

`simlock events` reads events, from the ring and from the event file.
`simlock daemon logs` reads the log. Neither prints the other. Someone who
needs both reads both and joins them by timestamp.

### 7. The event file is an observer

The writer subscribes to the bus like any other observer. If the file cannot
be opened or written, the daemon logs one error and carries on. No lease
operation waits on it or fails because of it.

## Consequences

- Event history survives a restart and reaches past the ring. It is bounded
  by size, not by age, with one rotated generation.
- Debugging a problem can mean reading two files. That is the price of
  keeping the log free to change and the event file free of noise.
- A later audit trail builds on the event file. Its retention can change
  without touching the log.
- On a gateway the event file holds the relayed fleet events too, so its
  volume is the fleet's. Writes are synchronous. This is accepted until it is
  seen failing.
- An event payload is now written to disk. A secret in a payload is a defect
  in the event and is fixed where it is emitted
  ([#170](https://github.com/callstackincubator/simlock/issues/170)).
- `daemon.log` gains the lines that make it useful on its own terms: one per
  operation, one per background failure. It stops being low-volume.
- Events rule 7 changes: an event is appended to the ring buffer and to the
  event file.

## Alternatives considered

- **One stream in `daemon.log`, with a filter for `simlock events`.**
  Rejected. Either every log message comes under the event contract, or there
  is a second class of event behind a flag, which is the two records again
  with a filter that fails open: a new internal line that misses its flag
  reaches agents, HTTP clients and the gateway, with config, paths and stack
  traces in it. The logger must also work where the bus cannot: before config
  loads, and when a bus subscriber itself fails. And per-request and debug
  lines would push facts out of the ring.
- **Copy every event into `daemon.log`.** The smallest change, and one file to
  read. Rejected because request lines and debug output would rotate facts
  out, and an audit trail needs its own retention.
- **Keep copying selected events into the log.** This is what the code did
  for two events. Rejected for the reason in §2.
