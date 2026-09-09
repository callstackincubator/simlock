# Agent rules: testing

Rules for writing tests in this repo. A test is a claim about behaviour that
outlives the person who wrote it, so these are binding in the same way the
other files here are: a change whose tests violate them is rejected even
though the suite is green — being green is exactly the failure mode.

1. **A test's title is a claim, and the body must prove that claim.** A title
   that promises more than the body asserts is a defect, not a wording
   problem: it tells every later reader the case is covered when it is not,
   and that reader stops looking. If the body cannot prove the title, narrow
   the title to what it does prove. The same goes for a comment above a test
   explaining what it guards.

2. **Every test must be able to fail, for the right reason.** Before you
   trust a test, break the code it covers, run it, and watch it fail on a
   *named assertion* — then restore the code. A test that still passes is not
   a test; it is a green light wired to nothing. A test that fails only by
   timing out pins the schedule rather than the behaviour, and will keep
   passing when the behaviour is wrong but fast. This is the single most
   repeated defect in this repo's review history: assertions that hold
   equally against the correct and the broken implementation.

3. **Production code that can be deleted with a green suite is untested.**
   For a new code path, try deleting it and run the suite. If nothing goes
   red, whatever you believed covered it stops short of the part that
   matters — usually because the test exercises an internal callback rather
   than the observable output the path exists to produce. Write the test that
   goes red, then restore the code.

4. **A test that enforces a rule must see everything the rule covers.** A
   boundary or invariant test enforces its rule only where it happens to
   look. One that scans a single directory, follows only static imports, or
   checks only the first element of a collection leaves the rest
   unguarded — and reads, to everyone after you, as though the whole rule
   were covered.

5. **A flake is not diagnosed until it reproduces on a commit that predates
   the change.** "Probably unrelated" and "it passed when I re-ran it" are
   guesses. Check out the base commit, run the same test, and let the result
   decide; a failure that reproduces there is not yours to fix in this
   change, and one that does not reproduce is yours. Never skip, disable, or
   quarantine a test to get to green.
