// why: these are the reasons agent-device's own client puts on an error when simlock gave no answer: the connection dropped, the body was not JSON (a proxy's 524 page), or the request timed out. Simlock's own reasons are upper case and say they were answered.
const NO_ANSWER_REASONS = new Set([
  "daemon_response_invalid",
  "daemon_response_read_failure",
  "daemon_transport_failure",
  "daemon_transport_timeout",
]);

function detailsOf(error: unknown): { reason?: unknown; retriable?: unknown } {
  const details = (error as { details?: unknown } | null)?.details;
  return typeof details === "object" && details !== null ? details : {};
}

export function mayAnswerLater(error: unknown): boolean {
  const { reason, retriable } = detailsOf(error);
  return retriable === true || (typeof reason === "string" && NO_ANSWER_REASONS.has(reason));
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
