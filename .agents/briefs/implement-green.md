# Mode `green`: turn the tests green in checkpoints

Start from `map`: read the files it names for the next failing test, not
the whole module. Make the smallest change that turns the next test green.
Each commit body states the failing count: `3 failing -> 1 failing`.

- Run only the commands under "Tests agents run" in `toolchain.md`: the
  changed unit tests, and the e2e files you added or edited. Never run a
  check listed under "Checks agents never run", nor a tool behind it, from
  any path. A type or lint error shows in the commit hook's output.
- The commit hook rejects a comment that does not start with `why:`
  (architecture rule 17). Delete it; start it with `why:` only when it says
  why the code does something a reader would not expect.
- Push once before your report, in the foreground: commits save progress,
  pushes do not need to. Read its whole output, not a tail. Never pass
  `--no-verify` or `-n`.
- Never wait on CI: no polling `gh pr checks`, no `gh run watch`, no
  `sleep` loops. Run `node .agents/scripts/ci-failures.mjs <M>` at most
  once, before the report: `none` is `ci: pass`, a failed test `ci: fail`.
- Never use `git stash`: all worktrees share one stash list. Commit instead.
  Temporary files go in your scratchpad, not `/tmp`.
- Build what `always-in-scope.md` lists as you go. Anything else you notice
  outside the spec becomes a `bug:new` issue or one line under `open`.
