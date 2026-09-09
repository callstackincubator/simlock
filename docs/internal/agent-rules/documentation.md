# Agent rules: documentation

Rules for anyone (human or agent) writing or editing documentation, or any
user-visible string the CLI/HTTP API/MCP server prints. Violating these is
grounds for rejecting a change even if the prose reads well.

1. **There are two audiences, and they get two directories.** `docs/` is for
   end users of the built tool — someone who installed `simlock` and wants to
   use, configure, or integrate with it. `docs/internal/` (plus `AGENTS.md` at
   the repo root) is for maintainers and coding agents changing simlock
   itself — architecture, ADRs, agent rules, known pitfalls, and future ideas.
   Before adding a new doc file, decide which reader it is for and put it in
   the matching directory; do not add a third category.
2. **An end-user doc never cites an ADR, and never links into
   `docs/internal/`.** A reader installing and using the tool does not need
   to know a decision record exists, why it was made, or what its number is.
   If a sentence's only content is "see ADR NNNN" or "see ARCHITECTURE.md",
   either state the fact directly and drop the citation, or delete the
   sentence — never leave a dangling reference to an internal doc standing in
   for an explanation. This applies to `docs/ABOUT.md`, `docs/CLI.md`,
   `docs/CLIENT.md`, `docs/CONFIGURATION.md`, `docs/HTTP-API.md`,
   `docs/EVENTS.md`, and `README.md`.
3. **Nothing the running tool prints or returns ever names a file path in
   this repository.** `--help` text, usage banners, error messages, and HTTP
   error bodies must not tell a user to go read a specific markdown file —
   that file may not exist for someone who installed from a package registry
   rather than cloned the repo, and even when it does, a bare relative path
   means nothing outside a checkout. Point at the GitHub repository itself
   (e.g. the `homepage`/`repository` URL in `package.json`) if a pointer is
   useful at all, or say the thing directly instead of pointing anywhere.
4. **A doc that genuinely serves both audiences gets split, not shared.**
   `docs/EVENTS.md` (end-user: event names, payloads, when they fire — the
   catalog `simlock events` output is checked against) and
   `docs/internal/EVENTS.md` (maintainer: the same catalog plus the ADR
   citations, authoring-rule cross-references, and design rationale behind
   each row) are the model. When a new event is added, update both in the
   same change — the end-user table and the internal one — rather than
   letting one drift into the authoritative copy and the other into a stale
   mirror.
5. **Casing is a directory-level convention, and new files match their
   neighbors.** The top-level files directly under `docs/` and directly under
   `docs/internal/` are `UPPER-CASE.md`. `docs/internal/adr/` and
   `docs/internal/agent-rules/` are their own established `lower-case.md`
   namespaces (ADR numbers, agent-rule topics) — match whichever directory a
   new file lands in, don't introduce a third casing style.
6. **A link that crosses `docs/` and `docs/internal/` needs the right
   relative prefix**, and it only ever runs in one direction: from
   `docs/internal/` out to `docs/` (e.g. `../CLIENT.md`) is fine — a
   maintainer doc pointing at the user-facing reference for the same
   feature. From `docs/` into `docs/internal/` is never fine (see rule 2).
