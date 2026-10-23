# 0047. `device.exec` fills in the lease's device, and refuses another

- **Status:** Proposed
- **Date:** 2026-10-23
- **Issue:** [#951](https://github.com/callstackincubator/simlock/issues/951)
- **Extends:** [ADR 0005](0005-gateway-and-worker-modes.md) §19a (the
  driver resolves the command). Nothing in 0005 is replaced.

## Context

`device.exec` runs one `simctl`, `adb` or `devicectl` command against a
lease on the worker that holds the device (ADR 0005 §19a). Only
`devicectl` gets the device from the lease: the driver adds
`--device <udid>` unless the arguments name one
(`src/drivers/ios/devicectl-exec.ts:211`). For `simctl` and for `adb`
on an emulator, the caller's arguments must name the device, and the
daemon parses none of them (`src/daemon/dispatcher.ts:696-712`). So every
caller copies the UDID or the adb serial out of the grant into every
command, and nothing stops one that copies the wrong one:
`simctl install booted …` can reach another agent's simulator in the
same device set.

Two requests need the device to be implied: an MCP tool that runs these
commands against the session's lease (#951), and `simlock simctl` /
`simlock adb` on a worker scoped to the caller's lease (#948). Where the
device sits differs per tool and per verb, and the drivers already own
each tool's grammar and refusal list (drivers rule 6).

## Decision

1. **The driver fills the lease's device in.** When `passthrough` is
   given a device (today only `device.exec` gives one), the driver puts
   that device into the command where the tool expects it. A caller
   leaves the device out:

   | Tool, device | Where the device goes | Already named |
   | --- | --- | --- |
   | `simctl`, simulator | First operand after the verb and the verb's own options, for verbs on the driver's device-verb list | Left as is when it is the lease's UDID (any letter case) |
   | `adb`, emulator | `-s <serial>` before the subcommand, unless the subcommand is on the driver's no-device list (`devices`, `version`, `help`, …) | `-s <the lease's serial>` left as is |
   | `adb`, physical phone | `-s <serial>`, as today | Any leading flag refused, as today |
   | `devicectl`, physical iPhone or iPad | `--device <udid>`, as today | `--device` / `-d` with the lease's UDID left as is |

   A `simctl` verb not on the device-verb list (`list`, `runtime`,
   `help`, `pair`, …) passes as today, with nothing filled in and nothing
   checked.

2. **Naming another device is refused.** Where the table above fills a
   device in, an argument that names a different device is refused with
   `PASSTHROUGH_REFUSED` before anything runs. The message names both the
   device the arguments named and the lease's own. For `simctl` that
   is another UDID-shaped operand or `booted`. For an emulator's `adb` it
   is `-s <other serial>`, `-d`, `-e` or `-t`. For `devicectl` it is a
   `--device` / `-d` with another value. This is still an accident
   boundary, not a security one: `xcrun simctl` stays reachable (drivers
   known gaps).

3. **Every `device.exec` caller gets it.** HTTP, the gateway relay, the
   programmatic client and MCP all reach the same driver call, so there
   is no opt-in flag. A caller that already names the lease's own device
   sees no change. Through a gateway the worker fills the device in, as
   it resolves every other part of the command.

4. **No contract change.** `device.exec`'s input and output keep their
   shape and the protocol is not bumped. A worker older than this change
   runs the arguments as given.

5. **The local path stays as it is until #948.** `driver.passthrough`
   passes no device, so `simlock simctl` and `simlock adb` on a worker
   are unchanged. #948 can pass the caller's lease's device to the same
   driver call and get the same rule.

```mermaid
sequenceDiagram
  participant C as Caller (MCP, HTTP, client)
  participant G as Gateway
  participant W as Worker dispatcher
  participant D as Driver
  C->>G: device.exec {leaseId, tool: simctl, args: [install, App.app]}
  G->>W: same, worker's lease id
  W->>D: passthrough(simctl, lease's device, args)
  alt arguments name another device
    D-->>W: PASSTHROUGH_REFUSED (names both devices)
    W-->>C: error, nothing ran
  else
    D-->>W: xcrun simctl --set <root> install <udid> App.app
    W-->>C: started, output chunks, {exitCode}
  end
```

## Consequences

- A caller writes `["install", "App.app"]` or `["shell", "getprop"]` and
  never copies a UDID or serial. The website's "name your device in the
  arguments" advice and the Android serial lookup go away.
- An HTTP caller that sends `booted` today, which the docs already tell
  it never to do, gets `PASSTHROUGH_REFUSED`.
- Each driver keeps a device-verb list (iOS) or a no-device list
  (Android). A new `simctl` verb is passed through unfilled until it is
  added to the list.
- In a fleet whose workers run mixed versions, a command that leaves the
  device out works only on workers that have this change.

## Alternatives considered

- **The MCP tool fills the device in itself.** That puts each tool's
  grammar in a frontend, which ADR 0005 §19c rules out for the refusal
  list for the same reason. HTTP and #948 would each need their own copy.
- **An opt-in `fillDevice` field on `device.exec`.** This bumps the
  protocol and leaves two behaviours to test and document. Callers that
  already name their own device see no change without it, so the flag
  buys nothing.
- **Fill in only, refuse nothing.** Smaller, but it leaves the
  wrong-device accident open on the one path that now knows where the
  device argument sits.
