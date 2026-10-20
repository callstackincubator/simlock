# Later checks

Read `review-protocol.md` and the previous resolution ledger. Round 1
reviewed the whole PR; this check covers `fix.patch` (`previous..commit`).
Missing delta or non-ancestor history means Assessment: incomplete.

For each applicable stable finding ID, report resolved with evidence or
still open. Check changed hunks and affected contracts for regressions, and
search the whole PR diff for other instances of confirmed defect classes.
Use actual impact to select lenses, including changed test assertions and
acceptance. Do not redo unaffected reviews or reopen an earlier disposition
without new evidence. A newly discovered PR regression still blocks at the
cap; only demonstrated pre-existing unrelated debt is separate follow-up.
