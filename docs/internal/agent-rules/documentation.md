# Agent rules: documentation

Rules for anyone (human or agent) writing or editing documentation, or any
user-visible string the CLI/HTTP API/MCP server prints. Violating these is
grounds for rejecting a change even if the prose reads well.

1. **There are two audiences, and they get two places.** The website's
   docs, `website/src/content/docs/docs/` (one `.mdx` page each, sidebar in
   `website/astro.config.mjs`), are for end users of the built tool —
   someone who installed `simlock` and wants to use, configure, or
   integrate with it. `docs/internal/` (plus `AGENTS.md` at the repo root
   and the module manuals, rule 7) is for maintainers and coding agents
   changing simlock itself — architecture, flows, ADRs, agent rules, and
   future ideas. Nothing else under `docs/` holds end-user docs.
   Before adding a new doc, decide which reader it is for and put it in the
   matching place; do not add a third category.
2. **An end-user doc never cites an ADR, and never links into
   `docs/internal/`.** A reader installing and using the tool does not need
   to know a decision record exists, why it was made, or what its number is.
   If a sentence's only content is "see ADR NNNN" or "see ARCHITECTURE.md",
   either state the fact directly and drop the citation, or delete the
   sentence — never leave a dangling reference to an internal doc standing in
   for an explanation. This applies to every page under
   `website/src/content/docs/` and to `README.md`.
3. **Nothing the running tool prints or returns ever names a file path in
   this repository.** `--help` text, usage banners, error messages, and HTTP
   error bodies must not tell a user to go read a specific markdown file —
   that file may not exist for someone who installed from a package registry
   rather than cloned the repo, and even when it does, a bare relative path
   means nothing outside a checkout. Point at a page of the website docs by
   its full URL (under `https://callstackincubator.github.io/simlock/docs/`)
   if a pointer is useful at all, or say the thing directly instead of
   pointing anywhere. A change that moves or renames a page a message points
   at updates the message in the same change.
4. **A doc that genuinely serves both audiences gets split, not shared.**
   The website's events reference (event names, payloads, when they fire)
   and `docs/internal/EVENTS.md` (the same catalog plus the ADR citations,
   authoring-rule cross-references, and design rationale behind each row)
   are the model. When an event is added or changed, update both in the
   same change.
5. **Casing is a directory-level convention, and new files match their
   neighbors.** The top-level files directly under `docs/internal/` are
   `UPPER-CASE.md`. `docs/internal/adr/` and `docs/internal/agent-rules/`
   are their own established `lower-case.md` namespaces (ADR numbers,
   agent-rule topics), and website pages are `lower-case.mdx` — match
   whichever directory a new file lands in, don't introduce a third casing
   style.
6. **Links between the two audiences run one way.** A maintainer doc may
   link to a website page for the same feature (by its full URL under
   `https://callstackincubator.github.io/simlock/docs/`); a website page
   never links into `docs/internal/` (see rule 2).
7. **Every module has a manual, beside its code.** `src/<module>/AGENTS.md`
   says what the module does today, how, and what a change must not break,
   in the shape of [../templates/manual.md](../templates/manual.md), in at
   most 150 lines. A `CLAUDE.md` beside it holds only `@AGENTS.md`, so Claude
   Code loads the manual when it reads a file in the module; other agents load
   it by the rule in the root `AGENTS.md`. A path that runs
   through several modules (startup, device selection, `device.exec`) is a
   flow doc under `docs/internal/flows/`, linked from each module's manual.
   A manual and a flow doc hold no rationale (the ADR does) and no history
   (git does); a known gap lives in its module's manual.

8. **Point at a value's source; never copy it.** A doc, manual or comment
   that needs a number, default, limit or version that code defines names
   the constant and its file (`PROTOCOL_VERSION_RANGE` in
   `src/contract/protocol.ts`), not its value, and never counts the items a
   list beside it or another file holds ("these commands", not "seven
   commands"). An end-user doc that must show a value shows it, and the PR
   that changes the value updates it.
9. **A change to the public surface updates the website in the same
   change.** The public surface is everything a user or an integrator
   meets: CLI commands, flags, output and exit codes; configuration keys
   and defaults; HTTP routes, bodies and error codes; MCP tools; the
   `simlock/client` and `simlock/admin` exports; events; console screens;
   prerequisites and install steps. A change that adds, removes or alters
   any of it updates every website page that describes it — the guide
   that walks through it and the reference table that lists it — and adds
   a page to the sidebar when a new task needs one. Nothing generates
   these pages: the author and the reviews keep them true. The push hook
   and CI run `.agents/scripts/docs-surface-check.mjs`, which fails a
   change to the surface files its header lists that changes no page under
   `website/src/content/docs/`, unless a commit carries the trailer
   `Docs: none (<reason>)`.
