# Agent rules: always in scope

What any change includes without its spec asking. Every item here is a rule
from another file in this directory, or a check `main` requires; this file
adds no policy of its own, it only puts them in one list. A spec does not
need to repeat them. The implementer builds them, the spec review reads
this file with every spec and treats each item as asked for, and the
`check-spec` skill does not report a spec for leaving them out. Where a
spec conflicts with a binding rule or accepted ADR, the rule or ADR wins
unless the maintainer explicitly authorizes its amendment. See
[the review protocol](../REVIEW.md) for precedence and assessment scope.

1. **Claims the change makes false.** A comment, doc paragraph or test name
   the change makes false is fixed or deleted in the same change
   (architecture rule 13). That covers the end-user docs — `README.md` and
   the website pages under `website/src/content/docs/`, which a change to
   the public surface updates in the same change (documentation rule 9) —
   the maintainer docs under `docs/internal/`, and the manual
   (`src/<module>/AGENTS.md`) of every module the change touches
   (documentation rule 7).
2. **What the tool prints.** Help text, usage banners, error messages and
   HTTP error bodies the change makes false are fixed in the same change
   (architecture rule 13), and none of them names a file path in this repo
   (documentation rule 3).
3. **Both event catalogs.** A new or changed event updates the website's
   events reference (`website/src/content/docs/docs/reference/events.mdx`)
   and `docs/internal/EVENTS.md` in the same change (events rule 8,
   documentation rule 4).
4. **A test for every new behaviour.** Every new behaviour a caller, a
   user, a stored record or an event can see has a test that goes red when
   its code is deleted, fallbacks and error paths included; in a strict
   area [toolchain.md](toolchain.md) names, every new path does (testing
   rule 3). The test fails on a named assertion for the right reason
   (testing rule 2), drives the module through its surface (testing rule
   6), and extends an existing test where one proves the claim next to it
   (testing rule 7).
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
9. **A module keeps its surface.** A new component that is a directory
   exposes what others use from its `index.ts`, nothing outside reaches past
   it (architecture rule 14), a host wires it through one factory
   (architecture rule 18), and a new module under `src/` gets its manual and
   a row in `docs/internal/ARCHITECTURE.md` (documentation rule 7).
10. **Fallow stays green.** A new file that nothing imports statically — an
   entry point, a dynamically loaded module, a config file only a tool reads
   — gets its entry in `.fallowrc.json`, and so does a new dependency
   nothing imports. `main` takes no change whose Fallow check failed
   (DELIVERY.md, "`main` and releases").
11. **Comments say why.** Every comment the change adds or edits starts with
   `why:` and says why, or is deleted; the commit hook and CI reject the
   rest (architecture rule 17).
12. **A vendored artifact's notice and row.** A change under `vendor/` updates
   that directory's `NOTICE.md`, its row in `docs/internal/VENDORED-CODE.md`
   and `vendor/README.md`'s index in the same change
   (vendor-and-third-party-code rule 11). A new first-level `vendor/`
   directory carries its license text under `LICENSES/` and a `NOTICE.md`;
   `src/source-hygiene.test.ts` enforces that shape, and counts a vendored
   binary as excluded from the text scan only where a `SHA256SUMS.txt` pins
   its digest (vendor-and-third-party-code rules 2, 3, 7).

**CI proves the suite.** CI runs the checks [toolchain.md](toolchain.md)
lists on every push, and the merge gate refuses a PR whose checks are not
green (delivery rule 15). So "nothing shows the suite is green" is never a
finding, in a review or in a spec check.
