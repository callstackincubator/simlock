/**
 * The two daemon session roles (ADR 0003 §3). Enforcement -- rejecting a session whose role is
 * below an operation's -- is the dispatcher's job (§2), which is PR 2. This module only
 * declares the vocabulary the rest of the contract is typed against.
 */
export const ROLES = ["agent", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Shape an `authorize` hook is given, per operation call (ADR §1's `ownsLease` example, §4's
 * principal/ownerId comparisons). `principal`/`role` come straight from the session (fixed at
 * `hello` for the connection's lifetime); `ownerId` is a lookup, not a value, because the hook
 * runs before the handler and the only resource identifier available at that point is whatever
 * the input schema already validated (e.g. `leaseId`) -- the dispatcher resolves it against
 * live state (the daemon's registry) at call time. Returns `undefined` for an id the lookup
 * does not recognize; `ownsLease` (below) treats that as authorized on purpose, so the
 * handler's own "unknown resource" error surfaces instead of a misleading `FORBIDDEN`.
 */
export interface AuthorizeContext {
  readonly principal: string;
  readonly role: Role;
  readonly ownerId: (id: string) => string | undefined;
}

/**
 * Builds an `authorize` hook that requires the calling session to either be `admin` (ADR §4:
 * "admin bypasses") or own the resource identified by `getId(input)`. This is the one
 * `authorize` hook this contract declares -- `lease.renew` and `lease.release` both use it (see
 * `operations.ts`); `lease.list`'s ownership is a filter over many records, not a single-id
 * check, so it is not a candidate for this helper and is handled entirely in its handler.
 */
export function ownsLease<Input>(
  getId: (input: Input) => string,
): (input: Input, context: AuthorizeContext) => boolean {
  return (input, context) => {
    if (context.role === "admin") return true;
    const ownerId = context.ownerId(getId(input));
    return ownerId === undefined || ownerId === context.principal;
  };
}
