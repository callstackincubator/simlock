# Agent rules: safety invariants

These invariants protect the user's machine. They are enforced centrally in
the cleanup reconciliation loop and the lease path — never bypass them, and
never enforce them only inside an individual rule or driver.

1. **Registry-only destruction.** Pitlane only shuts down, erases, or deletes
   devices, AVDs, snapshots, and runtimes that exist in its own registry
   (i.e. that pitlane created). Everything else on the machine is strictly
   read-only. This includes `doctor --fix` and `nuke`.
2. **Never touch a leased device.** No cleanup rule, reclaim, or reconcile
   action may target a device in `leased` state. The reaper filters this
   centrally; rules must not rely on their own checks.
3. **Cleanup rules propose, the reaper disposes.** Rules are pure functions
   over a read-only registry view returning proposed actions. A rule that
   executes side effects directly is a bug regardless of what it does.
4. **No implicit multi-GB downloads.** Missing runtimes / system images fail
   the request unless `--allow-download` was explicitly passed.
5. **Destructive CLI commands confirm or require `--yes`**
   (`release --all`, `nuke`). `cleanup` must always support `--dry-run`.
6. **Every destructive action is attributable.** Log/emit which rule or
   command caused it, on what target, and why (e.g. "idle 47m > T2=30m").
7. **Reconcile before trusting state.** On daemon startup (and in `doctor`),
   compare the registry against `simctl`/`adb` reality before acting on it;
   registry entries whose device vanished are marked, not silently recreated
   or re-deleted.
