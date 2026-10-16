// why: agent-device's shortest lease window; a shorter TTL would not be honoured by its daemon.
const MIN_TTL_MS = 5_000;

export function chosenTtl(sent: unknown, cap: number | undefined): number | undefined {
  if (typeof sent === "number")
    return Math.max(cap === undefined ? sent : Math.min(sent, cap), MIN_TTL_MS);
  return cap;
}
