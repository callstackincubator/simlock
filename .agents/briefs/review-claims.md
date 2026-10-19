# Claims review

You are checking that what the repository says is true of its code. You
have no other context and have not seen the issue the diff implements.

In the inputs directory: `rules/`, every rule file but `delivery.md`;
`diff.patch`; `stale-refs.txt`, lines anywhere in the repository that still
name a path, declaration or quoted string the diff removed; `briefs/calibration.md`,
when it exists, findings like yours that were rejected lately: read it
first. Repository: the worktree you were given, checked out at the reviewed
commit. Read and search it; edit nothing and run no tests.

A claim is any statement of fact in a comment, a doc, a test title, help
text or an error message. Check, and list what you checked, one line per
file: `path: 12 34-40 true, 56 F3`:

1. Every claim the diff adds or changes.
2. Every line in the sweep.
3. For each function, type, module or behaviour the diff changes: its doc
   comment, and every line in the docs that names it (search for its name
   and for the plain words that describe it).
4. Read affected module manuals and linked flows for context. Check claims
   the change makes false; do not audit unrelated lines simply because the
   manual or nearby comment was opened.

Only changed claims or claims invalidated by this PR block. Existing
unrelated debt is separate. Accepted future-state ADRs remain targets;
current implementation gaps do not make those target statements false.
Whether a comment may exist at all is the commit hook's (rule 17 in
`architecture.md`): judge only whether it is true.

A claim is false when the code at this commit contradicts it: a name or
path that no longer exists, a behaviour, order, owner, default or limit that
changed. Blocking: a false claim. A claim that is true but misleading is
no finding.

## Assessment

Follow `review-protocol.md` in the inputs. End with `Assessment: complete`
or `Assessment: incomplete — <missing scope and reason>`. Exhausted budget
or missing evidence is incomplete, never a defect or F0/pass. Findings
already supported remain valid; identify unresolved coverage separately.

## Output

`F0` is a good result: do not look for findings to have some. Output only
your list, then your findings: no preamble, no headings, no summary, no
narration, at most 400 words besides the list. Report every blocking
finding; there is no limit. Write a note only for a suspected leak of a
secret or a credential that you could not prove: at most two. One line per
defect, in this form and no other:

```
F<n> B|N <path:line> <the claim and what the code does instead, at most 25 words> [architecture 13] ev: <path:line, ...>
```

B is blocking, N a note. Do not suggest fixes. No findings after complete assessment: `F0`. Append the Assessment line.
