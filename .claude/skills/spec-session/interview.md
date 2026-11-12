# Stage 3: interview

Open with what you found and what you think is wanted:

- today's flow (the diagram from stage 2);
- the contradictions and conflicts you kept, one line each;
- your read of the request in one sentence, with a confidence and what is
  missing: "I read this as <...>. Confidence ~40%: missing who runs it and
  what done looks like."

Then walk the decisions as a tree. Business decisions are the root: who it
is for, the outcome, the non-goals, how anyone checks it. Technical
decisions hang off them: the ones that need an ADR, then the split into
tasks and the seam each task's tests drive. The frontier is every decision
whose prerequisites are settled.

## Rounds

- One round asks the whole frontier with `AskUserQuestion`, up to four
  questions per call, the decisions most others hang on first. Two
  questions never share a round when one's answer could change the other.
- Ask a decision only when it is expensive to reverse, changes scope, or
  changes what a user sees. Decide the others yourself and say so in the
  round's text; they go under Decisions (`Decided in the session: ...`).
- Ask nothing a rule, an accepted ADR or the code's handling of the same
  case already answers: adopt it and say so.
- Every question carries your recommendation: its option first, its label
  ending `(Recommended)`, the question worded so that picking it is the
  "yes". Each option says what it costs and where it changes things: this
  repo, another tool, or both. One decision per question, about five
  lines; context beyond three lines waits for `Explain`.
- The last option of every question is `Explain`: "Show the problem and
  what each option brings, then ask again." On `Explain`, write in plain
  text what the problem is and why it needs deciding now, and for each
  option what changes, what a user would see and what it costs, each with
  a picture (a Mermaid diagram, a before-and-after of the command and its
  output, or a short code snippet). Then ask the same question again,
  alone. The other answers of the round stand.
- An answer that sounds like good practice ("it should be robust") is not
  yet a decision. Ask what they would pick if nobody had to approve it.
- Write each answer into the draft feature file at once: replace the text
  it settles, leave no older wording beside it. Then recompute the
  frontier; an answer can reopen a branch.

## Facts while you wait

Never ask the maintainer what source can answer. Each time an answer
brings a claim about what code, another tool, the OS or a browser does
today, start a `spec-explorer` on it with `run_in_background: true` and
ask the next round without waiting; batch claims about one area. Another
tool is read in its source at the version `toolchain.md` names, never its
docs or memory. A claim only a run can settle (a simulator, a CLI) is run,
by you or a helper, before the design rests on it.

## ADRs

A decision that constrains more than one task or is expensive to reverse
becomes an ADR. Take the next number free on `main` and in open PRs
(`gh pr list --limit 100 --json files -q '.[].files[].path' | grep
docs/internal/adr/`), and open its PR at once, so another session cannot
take the number. Draft it in `docs/internal/adr/` at _Proposed_ on branch
`feature/<N>-adr`, with the diagrams `docs/internal/adr/README.md` asks
for. It holds the decision, its reasons and what was rejected. Shapes,
messages, limits and state live in the feature's design tables, and the
ADR points at the feature for them. The maintainer accepts it in the one
approval (stage 4).

## Done

The frontier is empty, and every claim the design will rest on about today
has a source line you opened or a command you ran. Wait for the background
explorers. A claim with no source is a question: ask it in one more round.
