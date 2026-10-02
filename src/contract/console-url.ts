/** The `http` config block, as far as the console's address depends on it. */
export interface ConsoleHttpConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
}

/** Hosts that mean "every interface": a browser cannot open them, so the address names this machine. */
const UNSPECIFIED_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * ADR 0011 §3: the daemon serves the console at `/` whenever HTTP is enabled. This is the
 * address `status.get` reports as `daemon.consoleUrl`; `undefined` when HTTP is off.
 */
export function consoleUrl(http: ConsoleHttpConfig): string | undefined {
  if (!http.enabled) return undefined;
  const host = UNSPECIFIED_HOSTS.has(http.host)
    ? "localhost"
    : http.host.includes(":") && !http.host.startsWith("[")
      ? `[${http.host}]`
      : http.host;
  return `http://${host}:${http.port}/`;
}

/**
 * `status.get`'s `daemon.consoleUrl`, ready to spread into the `daemon` block: absent rather
 * than `undefined` when HTTP is off. A worker's and a gateway's dispatcher both call this, so
 * the two cannot report the address differently.
 */
export function consoleUrlField(http: ConsoleHttpConfig): { readonly consoleUrl?: string } {
  const url = consoleUrl(http);
  return url === undefined ? {} : { consoleUrl: url };
}
