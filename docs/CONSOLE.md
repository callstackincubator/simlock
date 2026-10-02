# Web console

Part of the user manual: the web console is a page in your browser that shows
what a Simlock host, or a gateway and its workers, is doing. The daemon serves
it itself. There is nothing to install and nothing is fetched from the
internet.

The console is for people who operate Simlock. It needs an operator token.
Coding agents keep using the CLI, the MCP server, the client and the HTTP API.

This version has sign-in and a page for each entry in the console's
navigation: Workers, Leases, Waiting, Attention and Events.

## Turn it on

The console comes with the HTTP API. It is on whenever `http.enabled` is
`true`, and there is no separate switch for it. A gateway always has HTTP on.

On a single host, turn HTTP on and restart the daemon:

```sh
simlock config set http.enabled true
simlock daemon stop && simlock daemon start
```

`http.host` and `http.port` decide where it listens, `127.0.0.1:4700` by
default (see [CONFIGURATION.md](CONFIGURATION.md)).

## Open it

`simlock daemon start` and `simlock status` print the address:

```
Daemon running
Console: http://127.0.0.1:4700/
```

Open that address in a browser. `simlock status --json` has it as
`daemon.consoleUrl`. When HTTP is off there is no `Console:` line and no
`consoleUrl`.

When `http.host` is `0.0.0.0` or `::`, the daemon listens on every interface
and the address says `localhost`. From another machine, use this host's name
or address instead. An IPv6 host is shown in brackets, as a browser expects:
`http://[::1]:4700/`.

The console uses the HTTP listener and nothing else. To reach it from another
machine, use the same tunnel you use for the HTTP API (Tailscale, cloudflared,
a reverse proxy). Simlock does not do TLS.

Every page has its own address, such as `/workers`, so you can bookmark a page
or reload it.

## Sign in

Paste an operator token and press **Sign in**. To make one, run this on the
host or the gateway:

```sh
simlock token create --role operator
```

The secret is printed once. A token works only on the daemon that minted it:
a gateway's token does not sign in to a worker, and the other way round.

If the console does not accept the token, it says why:

| Message | What it means |
| --- | --- |
| This daemon does not know that token. | The token is mistyped, revoked, or from another daemon. |
| That token is real, but the console needs an operator token. | It is an agent token or a worker join token. |
| The daemon is starting. Try again in a moment. | The daemon answers, but has not finished starting. |
| The daemon cannot be reached. | Nothing answers at this address. |
| The daemon answered with an error (HTTP *n*). | Anything else; the daemon's log says more. |

## Staying signed in

The console keeps the token in this browser tab only.

- **Reload** the page and you stay signed in.
- **Open a new tab** and it asks for a token again.
- **Close the tab** and you are signed out.
- **Sign out** forgets the token at once.
- If the token is **revoked**, the console signs you out the next time it asks
  the daemon for anything, and at the latest when you reload.

Some browsers copy a tab's storage into a duplicated or reopened tab, so such a
tab may still be signed in.

## Workers

**Workers** lists every worker the daemon knows, as `simlock worker list`
does. On a gateway that is every worker that has joined it. On a single host
it is one worker: the host itself. The console looks the same either way.

Each worker shows:

| Fact | What it says |
| --- | --- |
| Connection | `connected`, `disconnected` or `incompatible`, and `drained` when the gateway sends it no new leases |
| Health | The worker daemon's own health: `running`, `starting` or `failed` |
| Protocol | `compatible`, or `incompatible` with the protocol versions each side speaks, so you can see which one to upgrade |
| Version | The worker's Simlock version |
| Devices | How many devices are running, and how many are leased |
| Capacity | Devices running out of the limit, per platform |

A worker the gateway could not read from yet says "Not reported" where it
has nothing to show.

Select a worker to open its page. It adds:

- **Devices**: every device on the worker, with its state, platform, model,
  runtime, mode and image tag. A leased device shows how long ago its lease
  was granted, and a device being provisioned or reclaimed on a connected
  worker how long that has taken so far. Other states show `—`: the daemon
  reports no time for them.
- **Leases**: the leases on this worker, as the Leases page shows them.
- **Host**: the operating system, the CPU architecture, and the version of
  each platform tool, such as Xcode or the Android emulator.
- **Catalog**: the models and runtimes the worker can lease. It is read again
  straight after a component is installed, and otherwise every 30 seconds.
- **Installs in progress**: each runtime or system image being downloaded or
  waiting to, how long it has been going, and how many requests wait on it.

A page the daemon cannot answer on a single host says "Not available on a
single host" in place of its content.

## Leases

**Leases** lists every lease the daemon holds, as `simlock list --leases`
does. On a gateway that is every lease on every worker, including the ones a
worker granted itself. On a single host it is the host's own leases.

Each lease shows:

| Fact | What it says |
| --- | --- |
| Holder | Who holds the lease (see below) |
| Worker | The worker the device is on, by its label, or its id when it has none |
| Device | The device's model and id |
| Mode | `slim` or `full` |
| Image tag | The image tag the device was created from, or `—` |
| Granted | How long ago the lease was granted |
| Expires in | How long until the lease expires unless it is renewed. It counts down every second. |
| Last renewed | How long ago the lease was last renewed, or granted if it never was |

Select a lease to open its page. It shows the same facts, the device's UDID,
and the id of the request that was granted the lease, while the daemon still
keeps it. A lease that has been released or has
expired says "Lease not found".

### Who holds a lease

A lease taken over the HTTP API belongs to the token that took it. The console
shows that token's label, with the token id beside it: `ci-runner-3
tok_9f2c`. Give each agent's token a label when you create it, so you can tell
them apart:

```sh
simlock token create --role agent --label ci-runner-3
```

A token created without `--label` shows as its id alone. A lease taken
through the CLI or the MCP server on the host itself is held by the agent id
it was taken with, and shows that id. The console matches a lease to a token
by id only, so an agent id that happens to equal a token's id shows that
token's label: the label names who the lease says holds it, not proof. On a
gateway the labels are the gateway's own tokens. A lease taken on a worker
directly shows its holder's id as that worker reports it.

## Waiting

**Waiting** lists every request waiting for a device, oldest first, as
`simlock list --requests` does. Each shows:

| Fact | What it says |
| --- | --- |
| Requester | The agent that asked |
| Device | The platform and model it asked for, and the runtime, mode and image tag when it named them |
| Worker | The worker whose own queue it waits in, or `—` for a request in a gateway's queue |
| Stage | `queued` while it waits its turn, `starting` while the daemon is working on it: placing it as it arrives, or finding, creating, booting or downloading a device for it |
| Place in queue | Where it stands, counting from 1, the requests ahead of it that are already starting included; `—` while starting |
| Waiting for | How long since the daemon received it |

On a gateway the list has the gateway's own queue and, for each connected
worker, the requests its own agents sent to it directly. A request the
gateway has passed to a worker shows once, as the gateway's. On a single
host every request shows that host as its worker.

A request leaves the list as soon as it gets its device, fails, or is
cancelled.

## Attention

**Attention** lists everything that needs you, in one place. Each item names
its worker and links to that worker's page. An item leaves the list as soon as
the daemon reports that its condition cleared. A gateway keeps a disconnected
worker's devices and RAM use as the worker last reported them, so their items
stay until the worker reconnects or is removed. The console only shows these;
it does not fix them.

| Item | What it means |
| --- | --- |
| `disconnected` | The gateway has lost its connection to the worker. |
| `incompatible` | The worker and the gateway have no protocol version in common. The worker's page says which versions each speaks. |
| `drained` | The worker gets no new leases (`simlock worker drain`). |
| `over RAM budget` | The devices on the worker use more RAM than its budget allows, as `simlock status` reports with `(over limit)`. |
| `quarantined` | A device Simlock could not clean up. It retries the cleanup in the background and leases the device to no one meanwhile. |
| `stalled` | A device stuck `provisioning` or `reclaiming` for longer than it should take, with nothing working on it. `simlock doctor` reports the same devices. |

The first three come from a gateway only: a single host has no gateway to lose
or disagree with, and cannot be drained. The other three show on a single host
too.

The navigation shows how many items there are beside **Attention**, on every
page. It shows no number while there are none.

Each item shows within about a second of the daemon reporting it. A stalled
device is the exception on a gateway: a device becomes stalled when its time
runs out, not by anything happening, so the gateway sees it the next time it
reads that worker, which it does at least every 30 seconds.

## Events

**Events** lists recent events, newest first: the same events as
`simlock events --since 1h`. New events appear at the top as they happen.

Each event shows:

- its time, on your computer's clock face
- its name, such as `lease.granted`
- on a gateway, the worker it came from, by its label, or by its id if the
  worker has no label or the gateway no longer knows it
- its payload, as each key and its value, exactly as the daemon sent it

An event this version of the console does not know still shows, with its
whole payload.

**Show** picks which events to list: all of them, or only those about leases,
devices, workers or components. **Other** lists the rest, such as
`daemon.started`.

The page keeps the newest 1000 events. Older ones drop off the end.

When the console loses the daemon, or the tab was hidden, it loads the events
it missed as soon as it is back, so the list has no gap. An event the console
already shows is never shown twice, also after the daemon restarts.

The console shows what the daemon sends. The daemon keeps secrets, such as a
worker's join token, out of its events.

## Live updates

Every page keeps itself current. A change on the daemon, such as a lease
being granted or a worker disconnecting, shows within about a second, with
no reload. Durations count up every second on their own. They are measured
by the clock of the daemon the console talks to, so a browser whose clock is
wrong still shows them right. On a gateway, a worker's lease, install and
waiting times come from that worker's clock: if it is far from the gateway's, its durations
are off by as much.

A hidden tab stops asking the daemon for anything. When you come back to it,
it catches up at once.

The line under the header says how the console's connection is:

| It says | What it means |
| --- | --- |
| Connected | Up to date. |
| Reconnecting — data from 12 s ago | The console lost the daemon. What you see is as old as it says. |
| Daemon is starting | The daemon is back, and is still starting up. |

While reconnecting, the console keeps the last data on screen and tries the
daemon again after 1, 2, 4 and 8 seconds, then every 10 seconds. When the
daemon answers, the console refreshes the page and the line goes back to
Connected. You do not need to reload.

## What the page loads

Everything the console needs comes from the daemon: the page, its script, its
styles and its fonts. The page tells the browser not to send anything to any
other host, so it works without internet access and your token stays with the
daemon.

The console's own files need no token, because they hold no data. Anyone who
reaches the HTTP listener can load the sign-in page and nothing more. Every
piece of data comes from the HTTP API, with your token.
