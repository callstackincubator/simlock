import type { Role } from "../contract/index.js";

/**
 * The seam PR 2's credential handshake (ADR 0003 §5) replaces wholesale. Everything else in
 * this PR -- the dispatcher, `DaemonServer`'s connection state, every operation's role check --
 * consumes only the resulting `{ principal, role }`, so the credential handshake changes
 * exactly one thing: what this function does. It does not change the dispatcher, the session
 * shape, or any handler.
 *
 * Today's implementation (`resolveAgentRole`, below) is deliberately trivial: every session
 * resolves to `"agent"` regardless of what `hello` sent, because nothing can prove `"admin"`
 * yet -- there is no credential to check (ADR §5's operator token and per-start admin secret
 * are both next-PR work). This is safe, not a stand-in for a check that happens to always
 * fail closed: an "admin" role granted to nothing yet just makes every admin-only operation
 * (`FORBIDDEN` by the dispatcher's role check) permanently unreachable on this daemon, which is
 * the conservative failure mode for "no auth exists yet" -- the alternative (defaulting new
 * sessions to "admin") would make the local socket as unauthenticated for destructive
 * operations as it always has been, one release later than this ADR intends to fix that.
 */
export interface SessionRoleResolver {
  /**
   * Resolves the role a session gets for its lifetime. `hello`'s already-validated payload is
   * the only input -- no socket-path or transport detail, so an HTTP session (next PR) can call
   * the exact same resolver. May throw `ADMIN_AUTHENTICATION_FAILED` (ADR §5): a resolver that
   * checks a credential and finds a bad one rejects `hello` outright, before any operation
   * runs, rather than silently downgrading to "agent".
   */
  resolve(hello: {
    readonly principal?: string;
    readonly credential?: string;
  }): Promise<Role> | Role;
}

/** PR 2's placeholder resolver: every session is "agent", unconditionally. See the module
 * comment for why this is a safe default rather than a security hole to fix urgently. */
export const resolveAgentRole: SessionRoleResolver = {
  resolve: () => "agent",
};
