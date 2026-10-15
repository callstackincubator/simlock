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
4. In each file the diff touches: every comment within 20 lines of a hunk,
   and the doc comment of every declaration the diff changes.
5. For each module the diff touches (`src/<module>/`): every line of its
   manual, `src/<module>/AGENTS.md`, and of each flow doc under
   `docs/internal/flows/` the manual links to.

Find them all now: a false claim this round misses costs a later round.
Whether a comment may exist at all is the commit hook's (rule 17 in
`architecture.md`): judge only whether it is true.

A claim is false when the code at this commit contradicts it: a name or
path that no longer exists, a behaviour, order, owner, default or limit that
changed. Blocking: a false claim. Note: a claim that is true but misleading.

## Output

`F0` is a good result: do not look for findings to have some. Output only
your list, then your findings: no preamble, no headings, no summary, no
narration. Report every blocking finding; there is no limit. At most five
notes; write no other note. One line per defect, in this form and no other:

```
F<n> B|N <path:line> <the claim and what the code does instead, at most 25 words> [architecture 13] ev: <path:line, ...>
```

B is blocking, N a note. Do not suggest fixes. No findings: `F0`.
