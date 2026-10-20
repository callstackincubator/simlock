import { type Fetch, hasSimlockErrorCode, RequestTimeoutError, send } from "./api";

export type IdentityOutcome =
  | { readonly kind: "proxy"; readonly name: string; readonly signOutUrl?: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "none" }
  | { readonly kind: "ended" }
  | { readonly kind: "unreachable" };

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

// why: the one place that decides what a failure in a proxy session means. An answer that is not
// Simlock's (the proxy's own login page, or a request that never arrived) is told apart from "the
// daemon is down" by `/v1/healthz`, which the proxy lets through.
//
// why: at load, a 5xx or a timeout from `/v1/identity` means no proxy session (the page opens with
// the token form); after a stream loss or a failed request in a proxy session it means the daemon
// is not answering, so the session is kept.
export async function checkIdentity(fetch: Fetch, afterLoss = false): Promise<IdentityOutcome> {
  const unanswered: IdentityOutcome = afterLoss ? { kind: "unreachable" } : { kind: "none" };
  let answer: Answer;
  try {
    answer = await send("/v1/identity", { fetch }, async (response) => ({
      body: await readJson(response),
      status: response.status,
    }));
  } catch (error: unknown) {
    if (error instanceof RequestTimeoutError) return unanswered;
    return askHealthz(fetch);
  }
  const { body, status } = answer;
  if ((status === 401 || status === 403) && !hasSimlockErrorCode(body)) return askHealthz(fetch);
  if (status >= 500) return unanswered;
  if (status === 200) return proxyIdentity(body) ?? { kind: "none" };
  if (status === 401) {
    const reason = (body as { error?: { reason?: unknown } }).error?.reason;
    if (typeof reason === "string") return { kind: "refused", reason };
  }
  return { kind: "none" };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function proxyIdentity(body: unknown): IdentityOutcome | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { name, signOutUrl, via } = body as Record<string, unknown>;
  if (via !== "proxy" || typeof name !== "string") return undefined;
  return typeof signOutUrl === "string"
    ? { kind: "proxy", name, signOutUrl }
    : { kind: "proxy", name };
}

async function askHealthz(fetch: Fetch): Promise<IdentityOutcome> {
  try {
    const up = await send("/v1/healthz", { fetch }, async (response) => response.ok);
    return { kind: up ? "ended" : "unreachable" };
  } catch {
    return { kind: "unreachable" };
  }
}
