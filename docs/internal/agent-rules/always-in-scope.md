# Agent rules: always in scope

What any change includes without its spec asking. Every item here is a rule
from another file in this directory, or a check `main` requires; this file
adds no policy of its own, it only puts them in one list. A spec does not
need to repeat them. The implementer builds them, the spec review reads
this file with every spec and treats each item as asked for, and the
`check-spec` skill does not report a spec for leaving them out. Where a
spec says otherwise in its own words, the spec wins.

1. **Claims the change makes false.** A comment, doc paragraph or test name
   the change makes false is fixed or deleted in the same change
   (architecture rule 13). That covers the end-user docs — `README.md`,
   `docs/ABOUT.md`, `docs/CLI.md`, `docs/CLIENT.md`, `docs/CONFIGURATION.md`,
   `docs/HTTP-API.md`, `docs/CONSOLE.md`, `docs/EVENTS.md` (documentation
   rule 2) — and the maintainer docs under `docs/internal/`.
2. **What the tool prints.** Help text, usage banners, error messages and
   HTTP error bodies the change makes false are fixed in the same change
   (architecture rule 13), and none of them names a file path in this repo
   (documentation rule 3).
3. **Both event catalogs.** A new or changed event updates `docs/EVENTS.md`
   and `docs/internal/EVENTS.md` in the same change (events rule 8,
   documentation rule 4).
4. **A test for every new path.** Every new code path has a test that goes
   red when the path is deleted, fallbacks and error paths included (testing
   rule 3), and the test fails on a named assertion for the right reason
   (testing rule 2). Every mutant `pnpm mutate` leaves alive is killed or
   explained in the PR body (testing rule 3, delivery rule 15).
5. **Tests that see their whole rule.** A test that enforces a boundary or
   invariant looks everywhere the rule covers, not only where the change
   happened to touch (testing rule 4).
6. **One place for a rule.** If the change would enforce a decision a second
   time, it moves the check to one place and deletes the copy in the same
   change (architecture rule 10).
7. **A port for a new external API.** A new external dependency gets its
   port interface and an in-memory fake for tests (architecture rule 9).
8. **Wire input bounded.** Anything new that arrives over the wire is
   validated for shape and bounds before it is used or stored (safety rule
   10).
9. **Fallow stays green.** A new file that nothing imports statically — an
   entry point, a dynamically loaded module, a config file only a tool reads
   — gets its entry in `.fallowrc.json`, and so does a new dependency
   nothing imports. `main` takes no change whose Fallow check failed
   (DELIVERY.md, "`main` and releases").

**CI proves the suite.** CI runs `pnpm check`, the console lane and Fallow
on every push, and the merge gate refuses a PR whose checks are not green
(delivery rule 15). So "nothing shows `pnpm check` is green" is never a
finding, in a review or in a spec check.
