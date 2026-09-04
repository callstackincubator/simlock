import type { Role } from "../contract/index.js";

/**
 * The seam PR 2a's dispatcher work left for this PR's credential handshake (ADR 0003 §5).
 * Everything else -- the dispatcher, `DaemonServer`'s connection state, every operation's role
 * check -- consumes only the resulting `{ principal, role }`, so the credential handshake
 * changes exactly one thing: what `resolve()` does. It does not change the dispatcher, the
 * session shape, or any handler.
 */
export interface SessionRoleResolver {
  /**
   * Resolves the role a session gets for its lifetime. `hello`'s already-validated payload is
   * the only input -- no socket-path or transport detail, so an HTTP session (this PR) can call
   * the exact same resolver. Throws `AdminAuthenticationFailedError` (ADR §5) when a credential
   * is present but matches neither the operator token store nor the per-start admin secret --
   * *before* the caller ever marks the session/connection as handshaken, so nothing runs on a
   * rejected `hello`.
   */
  resolve(hello: {
    readonly principal?: string;
    readonly credential?: string;
  }): Promise<Role> | Role;
}

/** Placeholder resolver kept for tests that don't care about roles: every session is "agent",
 * unconditionally, regardless of what `hello` sent. */
export const resolveAgentRole: SessionRoleResolver = {
  resolve: () => "agent",
};

/** Thrown by `createCredentialRoleResolver`'s resolver for a present-but-wrong credential.
 * Deliberately generic: the message never echoes the credential itself (ADR §5: "never
 * logged... never returned by any operation"), and `DaemonServer#errorCode` maps this to the
 * contract's `ADMIN_AUTHENTICATION_FAILED` the same way it maps every other typed rejection. */
export class AdminAuthenticationFailedError extends Error {
  constructor() {
    super("Invalid admin credential");
    this.name = "AdminAuthenticationFailedError";
  }
}

/**
 * ADR 0003 §5: what a `hello.credential` is checked against, in order -- an operator token
 * from the token store, then the daemon's own per-start admin secret. Kept as a narrow
 * structural interface (not `TokenStore`/`AdminSecretManager` directly) so this module -- and
 * anything testing it -- does not need to construct either of those, and so an HTTP session
 * (this PR's part B) can share the exact same verifier its socket counterpart uses.
 */
export interface AdminCredentialVerifier {
  /** Resolves `true` only for a credential that hashes to a token store record whose role is
   * `"operator"` -- an `"agent"`-role bearer token never grants admin here. */
  verifyOperatorToken(secret: string): Promise<boolean>;
  verifyAdminSecret(secret: string): boolean;
}

/**
 * Builds the real `SessionRoleResolver` (ADR §5): no `credential` resolves `"agent"`
 * (unconditionally -- a session that never asked for admin is never granted it); a `credential`
 * that verifies against either source resolves `"admin"`; anything else throws
 * `AdminAuthenticationFailedError`, which the caller must translate to a handshake failure
 * *before* marking the connection/session as having received `hello` -- see
 * `DaemonServer#handleHello` and the HTTP session adapter, both of which reject the credential
 * ahead of any other request being served, per the ADR's explicit ordering.
 */
export function createCredentialRoleResolver(
  verifier: AdminCredentialVerifier,
): SessionRoleResolver {
  return {
    resolve: async (hello) => {
      if (hello.credential === undefined) return "agent";
      if (await verifier.verifyOperatorToken(hello.credential)) return "admin";
      if (verifier.verifyAdminSecret(hello.credential)) return "admin";
      throw new AdminAuthenticationFailedError();
    },
  };
}
