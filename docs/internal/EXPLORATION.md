# Exploration contract

Use direct `rg` and source reads for a known symbol, path or straightforward
lookup. Delegate only when a bounded question or module search saves context
or can run independently. File unfamiliarity and output length alone are
not reasons to start a helper. Batch related questions; do not spawn one
helper per fact. A review does not require an exploration stage.

Haiku locates candidate evidence; it does not certify correctness or absence.
Use Sonnet when relationships remain ambiguous; use Opus for consequential
architecture, ownership or concurrency judgments. Follow the user's limits
on delegation. The same evidence contract applies to direct exploration.

Every assignment names its question, scope and commit. Return:

- Commit and question, with the searched paths and search terms.
- Facts: opened `path:line` locations and short supporting excerpts.
- Uncertainties, excluded paths and unanswered questions.
- Coverage: complete for the stated search, or incomplete, including output
  truncation, budget limits and omitted scope. No matches proves only that
  this search found nothing, never that no implementation or caller exists.

Read each result in enough surrounding source to check guards, callers and
state transitions before relying on it. Load module manuals before reading
source. About 30 facts is an output budget, not proof of exhaustive coverage;
report what was left out. Broaden a search or escalate an ambiguous answer
instead of turning uncertainty into a conclusion.

A requested change that differs from today's code is an intended delta, not
by itself a contradiction. Accepted future-state ADRs remain targets. Report
conflicts between binding requirements separately from implementation gaps.

Reuse verified evidence in issue Facts, handoffs and implementation stage
maps with the commit and scope attached. At a later commit, compare changed
paths and dependencies and revalidate affected entries; if that cannot be
determined, mark the map stale and repeat the relevant search. Reuse is
navigation, never a substitute for a reviewer's independent source access.
