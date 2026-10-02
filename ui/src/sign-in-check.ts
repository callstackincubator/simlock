import { type Fetch, RequestTimeoutError, send } from "./api";

/** What checking a pasted token found (ADR 0011 §6). */
export type SignInOutcome =
  | { readonly kind: "signed-in" }
  | { readonly kind: "unknown-token" }
  | { readonly kind: "not-operator" }
  | { readonly kind: "starting" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "failed"; readonly status: number };

/**
 * First `GET /v1/healthz`, to learn whether the daemon is up at all; then `GET /v1/workers`, a
 * read only an operator token may make, in both modes. A timeout on the second while the first
 * answered means the daemon is still starting: its reads wait until it is ready.
 */
export async function checkToken(token: string, fetch: Fetch): Promise<SignInOutcome> {
  try {
    const up = await send("/v1/healthz", { fetch }, async (response) => response.ok);
    if (!up) return { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
  let status: number;
  try {
    status = await send("/v1/workers", { fetch, token }, async (response) => response.status);
  } catch (error: unknown) {
    return { kind: error instanceof RequestTimeoutError ? "starting" : "unreachable" };
  }
  if (status === 200) return { kind: "signed-in" };
  if (status === 401) return { kind: "unknown-token" };
  if (status === 403) return { kind: "not-operator" };
  return { kind: "failed", status };
}

/** What the sign-in screen says for each refusal. */
export function refusalMessage(outcome: Exclude<SignInOutcome, { kind: "signed-in" }>): string {
  switch (outcome.kind) {
    case "unknown-token":
      return "This daemon does not know that token.";
    case "not-operator":
      return "That token is real, but the console needs an operator token.";
    case "starting":
      return "The daemon is starting. Try again in a moment.";
    case "unreachable":
      return "The daemon cannot be reached.";
    case "failed":
      return `The daemon answered with an error (HTTP ${outcome.status}).`;
  }
}
