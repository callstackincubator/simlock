/**
 * The two daemon session roles (ADR 0003 §3). Enforcement -- rejecting a session whose role is
 * below an operation's -- is the dispatcher's job (§2), which is PR 2. This module only
 * declares the vocabulary the rest of the contract is typed against.
 */
export const ROLES = ["agent", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Minimal shape a future `authorize` hook will be given (ADR §1's `ownsLease` example, §4's
 * principal/ownerId comparisons). Declared now so `defineOperation`'s `authorize` field has a
 * real type to point at; no operation in this PR actually sets `authorize`, and nothing calls
 * it -- the dispatcher that would is PR 2. `ownerId` is optional here because the field it
 * would compare against (`LeaseRecord.ownerId`) does not exist on the wire yet either (PR 2).
 */
export interface AuthorizeContext {
  readonly principal: string;
  readonly role: Role;
}
