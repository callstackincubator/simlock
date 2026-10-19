import type { Fetch } from "./api";

export type IdentityOutcome =
  | { readonly kind: "proxy"; readonly name: string; readonly signOutUrl?: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "none" }
  | { readonly kind: "ended" }
  | { readonly kind: "unreachable" };

export async function checkIdentity(_fetch: Fetch): Promise<IdentityOutcome> {
  return { kind: "none" };
}
