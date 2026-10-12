# A later round: review the fix, not the diff

This is not round 1. Round 1 reviewed the whole diff. Review only this:

1. Each line in `previous-fixes.md` tagged with your review: is it resolved
   at this commit? One line each: `<its path:line> resolved <fix.patch hunk
path:line>` or `<its path:line> not resolved`.
2. `fix.patch`, the diff from the last reviewed commit to this one: apply
   your brief's questions to its hunks only. A fix can break what it
   touches.
3. Each line in `previous-fixes.md` tagged with your review names a class
   in brackets: search the whole of `diff.patch` for another instance of
   that class.

Anything else you notice is a note, whatever its severity, unless it is
wrong behaviour or wrong state: report that as blocking, with its evidence,
and the orchestrator decides whether it is this PR's to fix.
