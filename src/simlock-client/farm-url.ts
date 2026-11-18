const MAX_URL_CHARS = 2048;
const MAX_TOKEN_CHARS = 4096;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

// why: a caller turns this into its own failure: `simlock tunnel` and the CLI into a usage error, the typed clients into a `TypeError`.
export class FarmUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FarmUrlError";
  }
}

// why: the one rule for a farm's URL, shared by `simlock tunnel` and the remote typed client (ADR 0081 §3): https, or http for loopback only, and the origin alone. The scheme is judged before the origin. `name` is how the caller calls the value (`--url`, `` `url` ``), and the result is the farm's origin.
export function checkedFarmUrl(text: string, name: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(text);
  } catch {
    parsed = undefined;
  }
  const allowed =
    parsed !== undefined &&
    (parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)));
  if (parsed === undefined || !allowed || text.length > MAX_URL_CHARS) {
    throw new FarmUrlError(
      `${name} must be https://, or http:// only for 127.0.0.1, [::1] or localhost`,
    );
  }
  if (parsed.pathname !== "/" || /[?#]/.test(text)) {
    throw new FarmUrlError(`${name} must be the farm's origin only: no path, query or fragment`);
  }
  return text.replace(/\/$/, "");
}

export function farmTokenFits(text: string): boolean {
  return text !== "" && text.length <= MAX_TOKEN_CHARS;
}
