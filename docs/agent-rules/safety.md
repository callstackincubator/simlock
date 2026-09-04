# Agent rules: safety invariants

These invariants protect the user's machine. They are enforced centrally in
the cleanup reconciliation loop and the lease path — never bypass them, and
never enforce them only inside an individual rule or driver.

1. **Registry-only destruction.** Simlock only shuts down, erases, or deletes
   devices, AVDs, snapshots, and runtimes that exist in its own registry
   (i.e. that simlock created). Everything else on the machine is strictly
   read-only. This includes `doctor --fix` and `nuke`.

   There is exactly one exception, and it is opt-in: `doctor --purge-orphans`
   may destroy a device that sits inside a *validly-marked Simlock device root*
   but has no registry record (see
   [ADR 0001](../adr/0001-simlock-owned-device-roots.md)). Root membership is a
   second, independent proof of ownership — nothing outside Simlock can put a
   device in that root, and Simlock never adopts a root it did not create
   empty. The exception is deliberately narrow: it is reachable only from that
   explicit command, never from the reaper, a cleanup rule, an idle tier, or
   `doctor --fix`. The reason is structural, not stylistic — every central
   safety filter in the reaper is written over registry records, and an orphan
   has none, so an orphan proposal would bypass the entire safety net rather
   than be checked by it. Keep marker validation off every unattended
   destruction path.
2. **Never touch a leased device.** No cleanup rule, reclaim, or reconcile
   action may target a device in `leased` state. The reaper filters this
   centrally; rules must not rely on their own checks. There is exactly one
   deliberate exception: crash recovery, in
   `ManagedDeviceLifecycle.recoverLeased`. The guard there is *inverted*, not
   removed — every other operation's target check requires "no lease
   references this device"; recovery's requires "a lease references this
   device, and its id is exactly the one recovery was authorised for". Any
   other lease, no lease, or a lease that has moved on all fail the check the
   same as before. The exception is also narrow in what it may do: it only
   ever reboots (`makeReady`) an already-provisioned device, never erases,
   destroys, or re-provisions one — recovering a crashed process is not the
   same privilege as recovering a lost device, and this rule does not grant
   the latter. No cleanup rule, reclaim path, or reconcile action gains any
   version of this ability; it lives nowhere but this one lease-scoped guard.
3. **Cleanup rules propose, the reaper disposes.** Rules are pure functions
   over a read-only registry view returning proposed actions. A rule that
   executes side effects directly is a bug regardless of what it does.
4. **No implicit multi-GB downloads.** Missing runtimes / system images fail
   the request unless `--allow-download` (or MCP's `allowDownload`) was
   explicitly passed, or `downloads.policy: "always"` is set in config --
   both count as the required explicit consent, and `downloads.policy:
   "never"` overrides either one back to forbidden. Warm-pool provisioning
   and startup convergence never trigger a download under any policy: they
   only ever reuse specs already committed to the registry, never resolve a
   new one.
5. **Destructive CLI commands confirm or require `--yes`**
   (`release --all`, `nuke`). `cleanup` must always support `--dry-run`.
6. **Every destructive action is attributable.** Log/emit which rule or
   command caused it, on what target, and why (e.g. "idle 47m > T2=30m").
7. **Reconcile before trusting state.** On daemon startup (and in `doctor`),
   compare the registry against `simctl`/`adb` reality before acting on it;
   registry entries whose device vanished are marked, not silently recreated
   or re-deleted. "Reality" means the contents of Simlock's own device roots,
   scoped by `simctl --set` and `ANDROID_AVD_HOME` — never the machine's
   default device locations.
8. **Ownership is proven, never inferred.** A device is Simlock's because it
   lives inside a validly-marked Simlock root, not because of what it is
   called. `Driver.listManaged()` must answer from root membership; the
   `simlock-` / `simlock_` naming is a cosmetic label with no authority behind
   it. Never treat a name, a prefix, or a serial-to-name attribution as
   evidence of ownership — a user can create a device with any name.
9. **Root validation fails closed.** If a device root is missing its marker,
   carries another instance's marker, is a symlink, or has the wrong owner or
   permissions, that platform's driver does not start and Simlock reports why.
   Never fall back to the default device location, and never adopt or mark a
   root Simlock did not create empty itself. The same applies to Simlock's adb
   server port: if it is occupied, the Android driver fails rather than
   attaching to whatever server is already listening there.
