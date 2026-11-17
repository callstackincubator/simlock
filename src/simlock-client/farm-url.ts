const MAX_URL_CHARS = 2048;
const MAX_TOKEN_CHARS = 4096;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type FarmUrlProblem = "scheme" | "origin";

// why: the one rule for a farm's URL, shared by `simlock tunnel` and the remote typed client (ADR 0081 §3): https, or http for loopback only, and the origin alone. The scheme is judged before the origin.
export function farmUrlProblem(text: string): FarmUrlProblem | undefined {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "scheme";
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!allowed || text.length > MAX_URL_CHARS) return "scheme";
  if (parsed.pathname !== "/" || /[?#]/.test(text)) return "origin";
  return undefined;
}

export function farmOrigin(text: string): string {
  return text.replace(/\/$/, "");
}

export function farmTokenFits(text: string): boolean {
  return text !== "" && text.length <= MAX_TOKEN_CHARS;
}
