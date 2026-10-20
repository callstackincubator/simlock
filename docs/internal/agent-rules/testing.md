# Agent rules: testing

Rules for writing tests in this repo. A test is a claim about behaviour that
outlives the person who wrote it, so these are binding in the same way the
other files here are: a change whose tests violate them is rejected even
though the suite is green — being green is exactly the failure mode.

A test is also a cost. Every later change to the code it covers runs it,
reads it, and may have to edit it. So the suite holds the fewest tests that
prove the behaviour, each at the cheapest level that can prove it
(rules 6 to 9).

1. **A test's title is a claim, and the body must prove that claim.** A title
   that promises more than the body asserts is a defect, not a wording
   problem: it tells every later reader the case is covered when it is not,
   and that reader stops looking. If the body cannot prove the title, narrow
   the title to what it does prove. The claim goes in the title, never in a
   comment above the test (architecture rule 17). A title may claim one
   behaviour with several cases ("maps the installer's progress to the
   percentage the requester sees"): the body then checks every case, as one
   table when the cases differ only in data.

2. **Every test must be able to fail, for the right reason.** Before you
   trust a test, break the code it covers, run it, and watch it fail on a
   *named assertion* — then restore the code. A test that still passes is not
   a test; it is a green light wired to nothing. A test that fails only by
   timing out pins the schedule rather than the behaviour, and will keep
   passing when the behaviour is wrong but fast. This is the single most
   repeated defect in this repo's review history: assertions that hold
   equally against the correct and the broken implementation; rule 10 lists
   the shapes it takes. An assertion on an exact count of things the test
   does not own (pending timers, calls, events) fails the day unrelated code
   adds one, and fails only under some schedules: assert on what the title
   names. A count on a fake or clock that only this test drives is owned. A test that some input is refused
   starts from an input that is accepted, asserts that, then changes one
   thing: otherwise it stays green when the input is refused for another
   reason.

3. **What a caller can see is tested; in a strict area, every path is.**
   Every behaviour a caller, a user, a stored record or an event can see
   has a test that goes red when its code is deleted, error paths and
   fallbacks included. A branch whose deletion nobody can see needs no test:
   it is a candidate for deletion. In the strict areas
   [toolchain.md](toolchain.md) names, which guard safety rules or state
   that runs under concurrency, production code that can be deleted with a
   green suite is untested, whether anyone can see the difference or not;
   only a log line is left to rule 8.
   When nothing goes red, whatever you believed covered the path stops short
   of the part that matters — usually because the test exercises an
   internal callback rather than the observable output the path exists to
   produce. Write the test that goes red, then restore the code. Mutation
   testing does this mechanically, weekly, for the newest changes on `main`
   ([toolchain.md](toolchain.md) says where it runs).

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
   Once a failure has reproduced on a base commit, it is recorded so nobody
   proves it again: an open issue labelled `flaky-test` names the test by
   file and title. A failure that matches an open `flaky-test` issue skips
   the base-commit run; link the issue in the PR instead. One that
   reproduced on base and has no issue gets a `bug:new` issue with that
   label. Closing the issue ends the exemption.

6. **Test a module through its surface.** A test drives a module through
   what its entry point exports, or through a host surface above it (a
   command, an HTTP route, a tool call). A test of an internal file earns
   its place only for pure logic with many cases (a planner, a parser) or
   for an ordering the surface cannot force, and says which in a `why:`
   comment above its `describe`; any other goes through the surface, or is
   deleted when a surface test already proves its claim. What the module does to a port
   (a driver call, a download, a write) is output, and a fake port's record
   of it is a fair assertion; the exact sequence of those calls is not,
   unless the order is the claim. Internal state (a claim, a reservation, a
   private field or method) is proven by what happens next: "the slot is
   freed" is "a later request at the limit is granted". A change that keeps
   behaviour and only moves code edits no test; one that has to shows the
   tests pin structure, not behaviour.

7. **Prove each claim once, at the cheapest level that can prove it.**
   Before you add a test, search for one that already proves the claim or
   the behaviour next to it, and extend that one (a case, an assertion);
   write a new test only when none does. A spec's Tests line is one test:
   the cases it lists go in that test's body, as one table when they differ
   only in data, never one test per case. A contract several
   implementations share (the worker's and the gateway's handlers of one
   operation) is one suite run over each of them. Behaviour a change keeps
   "as today" is proved by the test that already proves it; a new test
   only when none does, or as the control case a new group of tests needs.
   A claim proved at one level is not proved again at another, nor through
   a second seam of the same level:

   | Claim                                                      | Level                                               |
   | ---------------------------------------------------------- | --------------------------------------------------- |
   | Modules are wired together; a wire format; what a command prints | end to end, with the platform faked           |
   | Branches, errors, ordering, safety rules                   | the module's surface (rule 6)                       |
   | What an external tool prints, and how it is read           | that tool's real output, recorded as a fixture      |
   | It works on a real device                                  | the slow lane, only where nothing cheaper proves it |

8. **A property every instance shares is one test.** When every instance
   of something must have the same property (every event matches its
   documented payload, every error body carries a code, every command has
   help text), one test checks every instance (rule 4), not one test per
   instance. A log line is tested only when the user docs describe it.

9. **A regression test is for a bug that reached `main`.** A bug found on
   `main` keeps its reproduction as its regression test. A defect a review
   finds in a pull request is fixed and proven as rule 7 says: by extending
   the test that proves the behaviour next to it, and by a new test only
   when none does; the fix report then names the test it could not extend,
   and why. A review asks for a test only for such a defect, or for
   behaviour rule 3 or the spec requires: never for a case that cannot
   happen.

10. **The usual ways an assertion cannot fail.** Each of these passes
    against a broken implementation; check every test you write or change
    against the list:

    - **A clause of the title has no assertion.** "Grants X and reserves
      capacity" checks the grant only. Every clause gets its own assertion.
    - **"Every", "any" or "whatever" proved by one case.** Two cases at
      least, one of them the edge. A claim about a choice ("the least
      recently used", "the id breaks the tie") needs a fixture with something
      else to choose.
    - **Order, one write, or a state on the way, read from the end state.**
      Two writes, or the wrong order, end in the same state. Observe the
      order (events in sequence, a step held and its state asserted) or
      inject a fault between the writes.
    - **An assertion that a failure also satisfies.** `not.toBe(pending)`
      passes on a rejection; `toBeInstanceOf(Error)` passes on a
      `TypeError`; `x?.()` passes when nothing was recorded. Assert the
      exact value, or the named error and its code.
    - **An expected value the code under test computed.** `expect(total)
      .toBe(blocks * bsize)` with the code's own formula, or a value read
      back through the module the test exercises, passes whatever the
      formula gets wrong. Take expected values from a literal, a worked
      example or the spec. Comparing two outputs of the code is fair only
      when the claim is that they match (field order does not matter, routed
      equals direct), and one of them is also asserted against a literal.
    - **State read from a copy taken before the act.** Read it again from
      the system after.
    - **A time boundary not straddled.** One advance past both the old and
      the new deadline proves neither; assert just before and just after.
      Let pending work finish before asserting. To prove something never
      happens, advance past the moment it would.
