import type { CliResult } from "../helpers/cli.js";

export const PROXY_URL = "http://127.0.0.1:4180";
export const GATEWAY_PORT = 4700;
export const ISSUER = "http://127.0.0.1:5556/dex";
export const ALICE = { email: "alice@example.test", password: "password" } as const;

export interface LaneDaemon {
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  dispose(): Promise<void>;
}

const NOT_STARTED: LaneDaemon = {
  cli: async () => ({
    code: 1,
    error: undefined,
    json: undefined,
    stderr: "not implemented",
    stdout: "",
  }),
  dispose: async () => undefined,
};

/**
 * why: placeholders so the red tests compile; green starts the gateway on port 4700 with the
 * `http.proxyAuth` the lane documents, and a worker joined through the proxy.
 */
export async function startGateway(): Promise<LaneDaemon> {
  return NOT_STARTED;
}

export async function startWorker(_join: {
  readonly gatewayUrl: string;
  readonly token: string;
}): Promise<LaneDaemon> {
  return NOT_STARTED;
}
