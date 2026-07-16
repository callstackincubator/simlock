# Stage 10 — CLI

Goal: the agent-facing surface. Implement docs/CLI.md exactly — commands,
flags, exit codes, stdout/stderr protocol. The CLI is a thin client
(architecture rule 8): parse, talk to daemon, render, hold.

## Implement (in `src/cli/`)

- Arg parsing with `node:util` `parseArgs` per command; human duration
  parsing ("30s", "10m") at this boundary only.
- Daemon client: connect to socket; if absent, auto-start the daemon
  (spawn `node dist/daemon/main.js` detached, stdio to
  `~/.pitlane/daemon.log`, retry connect with backoff, fail after ~5s).
- **`lease`** held mode: request → print progress JSON lines on stderr as
  push frames arrive → on grant print ONE result JSON line on stdout →
  keep process alive holding the connection. SIGINT/SIGTERM → send
  lease.release, close, exit 0. `--detach`: print result with lease token,
  exit 0. `--no-wait`/`--timeout`/`--allow-download` map to protocol params.
- All other commands from CLI.md: `lease renew`, `release` (id | `--all`
  with confirm/`--yes`), `status` (human table default, `--json`), `list`,
  `cleanup` (`--dry-run`, `--rule`), `events` (`--follow` via
  events.subscribe, `--since`), `daemon start|stop|status|logs`, `config`
  (get/set writes config file; note "takes effect on daemon restart"),
  `doctor`/`nuke` — register the commands but they may return
  "not implemented until stage 13" errors (exit 1) to keep scope tight.
- **Exit codes exactly per CLI.md**: 0/1/2/10/11/12. Map typed daemon errors
  → codes in one translation table.

## Tests first

- Exit-code table: each typed error from a stubbed daemon connection maps to
  the documented code (timeout→10, no-wait→11, RuntimeMissing/UnknownModel→12,
  usage→2).
- Held-mode contract test against an in-process daemon (from stage 09 test
  harness) with FakeDriver: stdout gets exactly one parseable JSON line;
  progress lines only on stderr; SIGTERM releases (daemon-side lease gone).
- `--detach` prints token and exits; `renew` works against it.
- Arg validation: missing --platform/--device → exit 2 with usage on stderr.
- Duration parsing ("90s", "10m", bare ms) round-trips.
- `status --json` shape is stable (snapshot test).

## Watch out

- stdout purity in `lease` is a hard contract for agents: nothing but the
  single result line ever goes to stdout (progress, warnings, errors →
  stderr).
- Auto-start race: two CLIs starting simultaneously both spawning daemons —
  first bind wins, loser retries connect; test with two parallel starts if
  feasible, otherwise reason it through in the daemon (stage 09 covered
  single-instance).
- No business logic: if you're tempted to check capacity or validate specs
  client-side, stop — send it to the daemon.

## Acceptance criteria

- [ ] Every command in CLI.md exists (doctor/nuke may stub with clear error).
- [ ] Exit codes + stdout/stderr protocol match CLI.md exactly, tested.
- [ ] Held lease end-to-end against in-process daemon works, incl. signal
      release.
- [ ] `node dist/cli/main.js --help` prints usage; `pnpm check` green.
