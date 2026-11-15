import { z } from "zod";
import { authorizeOneLeaseCall, defineOperation } from "./operation-definition.js";
import { INPUT_ORIENTATIONS } from "./orientation.js";
import { ownsLease } from "./roles.js";
import {
  leaseRecordSchema,
  passthroughCommandSchema,
  platformSchema,
  requesterIdSchema,
  statusLeaseSchema,
} from "./schemas.js";

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseCancel = defineOperation({
  name: "lease.cancel",
  role: "agent",
  effect: "write",
  input: z.object({
    requesterId: requesterIdSchema.optional(),
    platform: platformSchema.optional(),
  }),
  output: z.object({ result: z.enum(["cancelled", "not-found", "not-cancellable"]) }),
  /**
   * why: ADR §9: "cancels this principal's pending request by requester id". Gated on the pending
   * request's *recorded owner* (`pendingRequestOwner`, ADR §4's `ownerId` -- always the
   * creating session's principal, never the caller-suppliable `requesterId`), not on comparing
   * `requesterId` to the principal directly -- that comparison would forbid exactly the case
   * ADR §4 exists for: one connection (`principal: "host"`) proxying many agents, each under
   * its own `requesterId` (`"agent-7"`). Deliberately not `ownsLease` (that hook resolves a
   * *lease's* recorded `ownerId` from the registry; a pending, not-yet-granted request has no
   * lease yet to look up -- `pendingRequestOwner` is the wait-queue equivalent). An omitted
   * `requesterId` defaults to the principal the same way the handler's own default does (see
   * `dispatcher.ts`'s `#leaseCancel`), so it always resolves to a request this principal owns.
   * A `requesterId` with no pending request resolves `pendingRequestOwner` to `undefined`,
   * which is treated as authorized (same convention as `ownsLease`) so the handler's own
   * `not-found` surfaces instead of a misleading `FORBIDDEN`.
   */
  authorize: (input, context) => {
    if (context.role === "admin") return true;
    const owner = context.pendingRequestOwner(
      input.requesterId ?? context.principal,
      input.platform,
    );
    return owner === undefined || owner === context.principal;
  },
});

/**
 * ADR 0004 §1: the only thing that keeps a lease alive, on every transport. An omitted `ttlMs`
 * re-applies the lease's own stored width -- never `lease.defaultTtlMs` -- so a lease granted
 * for four hours does not shrink to fifteen minutes the first time something renews it. A
 * `ttlMs` above `lease.maxTtlMs` is `BAD_REQUEST`, checked in the dispatcher's handler where
 * that config value is visible.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseRenew = defineOperation({
  name: "lease.renew",
  role: "agent",
  effect: "write",
  input: z.object({ leaseId: z.string(), ttlMs: z.number().finite().positive().optional() }),
  output: leaseRecordSchema,
  authorize: ownsLease((input) => input.leaseId),
});

export const leaseRelease = defineOperation({
  name: "lease.release",
  role: "agent",
  effect: "write",
  input: z.object({ leaseId: z.string() }),
  output: z.object({ leaseId: z.string() }),
  authorize: ownsLease((input) => input.leaseId),
});

/**
 * Builds the scoped command behind `simlock simctl` / `simlock adb`. It lives in the daemon
 * rather than the CLI because only the driver that proved a device root knows which flag points
 * its tool at that root, and which verbs would change a device's lifecycle behind the registry's
 * back -- neither is knowledge a frontend is entitled to (ADR 0003 §11: frontends render the
 * contract and nothing else).
 *
 * `role: "agent"`: the wrappers exist so a lease holder can reach a contained device, which is
 * an agent's job. It grants no authority of its own -- the refusal list lives in the driver, and
 * what comes back is a command the caller could have written had it known the root path, which
 * ADR 0001 is explicit is an accident boundary rather than a security one.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const driverPassthrough = defineOperation({
  name: "driver.passthrough",
  role: "agent",
  effect: "read",
  input: z.object({ args: z.array(z.string()), tool: z.string().min(1) }),
  output: passthroughCommandSchema,
});

/** why: the File name rule of a lease's files (1 to 128 characters), shared by the upload routes and exec's `stdinFile`. */
export const LEASE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// why: the daemon parses a request as one string, so unbounded stdin exhausts the heap (#1242).
export const EXEC_STDIN_MAX_LENGTH = 8_388_608;

/**
 * Runs `simctl`, `adb` or `devicectl` **on the machine that owns the device** and streams the output back
 * (ADR 0005 §19a). The difference from `driver.passthrough` is where the process runs, not
 * what it is: the same driver resolves the same scoped command with the same refusals --
 * the daemon then spawns it itself instead of handing the caller a command line it could only
 * run if it happened to be on that machine. That is what makes a leased device reachable from
 * a remote HTTP agent today, and through a gateway later, without a second network path.
 *
 * `role: "agent"`, gated on the lease's requester: driving a device is an agent's job, but --
 * unlike `driver.passthrough`, which only builds a string -- this one actually runs a command
 * against a machine, so it is gated on the caller being who the lease was granted to (see the
 * `authorize` hook below). `leaseId` is that proof: for `simctl` and `adb` the command's own
 * arguments may leave the device out and the daemon parses none of them: the driver puts the
 * lease's device where the tool expects it (ADR 0047 §1) and refuses a command that names
 * another one.
 *
 * A bare `adb shell` (nothing to run) is refused by the driver on this path, because there is
 * no terminal to attach it to and it would otherwise sit until `exec.timeoutMs` -- the same
 * `PASSTHROUGH_REFUSED` a lifecycle verb gets. Locally, where the CLI hands the tool its own
 * terminal, it stays allowed and interactive.
 *
 * Every command runs with the lease's folder on the worker as its working folder (ADR 0067 §5),
 * so a relative path names a file the holder uploaded. `stdinFile` names such a file to pipe to
 * the command's stdin instead of `stdin`; the two together are `BAD_REQUEST`, checked by the
 * worker's dispatcher, not here, because `.omit()` cannot build `run_on_device`'s input from an
 * object carrying a refinement.
 *
 * `stdin` is a **one-shot string**, not a stream: it is written to the child's stdin and the
 * pipe is then closed. ADR §19c is explicit that there is no pseudo-terminal here, so
 * line-oriented commands (`adb shell getprop`, `simctl spawn`) work and full-screen or
 * interactive ones (`adb shell` with no argument, a curses UI) do not -- and a client that
 * could feed such a program keystrokes over time would only make that failure slower to
 * discover. Locally, `simlock adb shell` still spawns with inherited stdio and stays fully
 * interactive (ADR §19c).
 *
 * `tool` is an open string, exactly as `driver.passthrough`'s is, and for the same reason:
 * which wrappers exist is the drivers' answer, not the contract's. A name no driver on that
 * machine wraps comes back as `UNKNOWN_PASSTHROUGH_TOOL` -- the code that already means
 * precisely that, at the 422/exit-2 it already carries -- rather than as a `BAD_REQUEST`,
 * which would say the request was malformed when it was merely aimed at a tool this host does
 * not have. `BAD_REQUEST` on this operation means the body's shape is wrong, nothing more.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const deviceExec = defineOperation({
  name: "device.exec",
  role: "agent",
  effect: "write",
  input: z
    .object({
      leaseId: z.string(),
      tool: z.string().min(1),
      args: z.array(z.string()),
      stdin: z.string().max(EXEC_STDIN_MAX_LENGTH).optional(),
      stdinFile: z.string().regex(LEASE_FILE_NAME_PATTERN).optional(),
      /**
       * why: Who this command is being run *for* -- the requester the lease is attributed to (ADR
       * 0003 §4), not the connection's principal. Read **only on an admin session**, where it
       * is the gateway case: a gateway holds one admin session over its uplink and proxies
       * many agents through it, each under its own namespaced requester id (ADR 0005
       * §19b/§27). A non-admin session that supplies one at all is refused by `authorize`
       * below rather than having it quietly ignored -- ADR 0003 §2 puts a contract
       * operation's answer in the dispatcher, not a transport, and a request that names an
       * identity and is answered as if it had not is the kind of silence that reads like
       * authorization (round 4, F4).
       */
      requesterId: requesterIdSchema.optional(),
    })
    .strict(),
  /**
   * why: Only the exit code: every byte the command wrote already left as `output` pushes while it
   * ran (see `pushes.ts`), so an answer that also carried the output would mean the daemon had
   * buffered all of it -- which ADR §19e forbids, and which is why there is no size cap here
   * to speak of either.
   */
  output: z.object({ exitCode: z.number() }),
  /**
   * why: `ownsLease` for an agent, and something stricter for an admin.
   *
   * An **agent** session is gated exactly like `lease.renew`: its principal against the
   * lease's `ownerId`. It may not supply `requesterId` at all -- round 4, F4: this used to be
   * read and then silently ignored, which left the rule "an agent may not name a
   * `requesterId`" living only in the HTTP route (`src/http/app.ts`) rather than here, so the
   * unix socket (and the future uplink, and any `simlock/client` consumer) answered a request
   * naming an identity as if it had named none. A non-admin session naming one at all is now
   * `FORBIDDEN` on every transport, uniformly, whether or not the name it chose happens to
   * match anything real.
   *
   * An **admin** session does not get `ownsLease`'s bypass on this operation. Every other
   * admin-bypasses hook is about an operator reaching past ownership on their own machine;
   * this one is the check a gateway's uplink session runs against, and a bypass there would
   * mean any admin-role connection could drive every lease on the worker -- the exact hole
   * §19b's "ownership is checked at the gateway, and again at the worker" exists to close.
   * So an admin is held to the lease's `requesterId` instead: it names the agent it is
   * proxying for (defaulting to its own principal), and a mismatch is `FORBIDDEN`. An
   * operator who means to reach another agent's device names that agent explicitly, which is
   * a deliberate act rather than an implicit privilege.
   *
   * An unknown lease id resolves to `undefined` on either lookup and is treated as
   * authorized, the same convention `ownsLease` uses, so the handler's own `UNKNOWN_LEASE`
   * surfaces instead of a misleading `FORBIDDEN`.
   */
  authorize: authorizeOneLeaseCall,
});

/**
 * ADR 0005 §20: the element carries an optional `workerId` -- absent from a worker's own
 * answer, set by a gateway, which lists the leases its worker views report. Additive, so a
 * client that never talks to a gateway sees exactly what it saw before.
 */
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseList = defineOperation({
  name: "lease.list",
  role: "agent",
  effect: "read",
  input: z.object({}),
  output: z.object({ leases: z.array(statusLeaseSchema) }),
});

// why: no `authorize` hook -- the handler answers `UNKNOWN_LEASE` for a lease the caller does not own, as `lease.list` hides it (ADR 0044 §3), so "not yours" and "not there" look the same.
// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseGet = defineOperation({
  name: "lease.get",
  role: "agent",
  effect: "read",
  input: z.object({ leaseId: z.string() }),
  output: z.object({ lease: statusLeaseSchema }),
});

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const leaseReleaseAll = defineOperation({
  name: "lease.release-all",
  role: "admin",
  effect: "write",
  input: z.object({}),
  output: z.object({ leaseIds: z.array(z.string()) }),
});

/**
 * why: turns a leased iOS phone or tablet simulator, through the lease's device input, whether or not the input module is on.
 */
export const deviceRotate = defineOperation({
  name: "device.rotate",
  role: "agent",
  effect: "write",
  input: z
    .object({
      leaseId: z.string().min(1).max(256),
      orientation: z.enum(INPUT_ORIENTATIONS),
      // why: rotate always refused an empty requesterId, so the shared format also keeps min(1).
      requesterId: requesterIdSchema.pipe(z.string().min(1)).optional(),
    })
    .strict(),
  output: z.object({ leaseId: z.string().max(256), orientation: z.enum(INPUT_ORIENTATIONS) }),
  authorize: authorizeOneLeaseCall,
});
