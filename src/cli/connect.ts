import type { SimlockAdminClient } from "../admin/index.js";
import { UsageError } from "./errors.js";
import type { CliEnvironment, RemoteFarm } from "./types.js";

const ADMIN_TOKEN_FILE_READ_ATTEMPTS = 3;
const ADMIN_TOKEN_FILE_RETRY_DELAY_MS = 50;

async function readAdminTokenFileWithRetry(
  environment: CliEnvironment,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < ADMIN_TOKEN_FILE_READ_ATTEMPTS; attempt++) {
    const token = await environment.readAdminTokenFile();
    if (token !== undefined) return token;
    if (attempt < ADMIN_TOKEN_FILE_READ_ATTEMPTS - 1) {
      await environment.sleep(ADMIN_TOKEN_FILE_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

type CredentialSource = "flag" | "env" | "file" | "none";

async function isAdminAuthFailure(error: unknown): Promise<boolean> {
  const { isSimlockError } = await import("../contract/index.js");
  return isSimlockError(error) && error.code === "ADMIN_AUTHENTICATION_FAILED";
}

function writeAgentFallbackNotice(environment: CliEnvironment, source: CredentialSource): void {
  const notice =
    source === "file"
      ? "local admin.token credential was rejected by the daemon (stale after an unclean " +
        "shutdown or restart?); connecting as agent (admin-only commands will fail with FORBIDDEN)"
      : source === "none"
        ? "admin credential unavailable; connecting as agent (admin-only commands will fail with FORBIDDEN)"
        : "admin credential was rejected by the daemon; connecting as agent (admin-only " +
          "commands will fail with FORBIDDEN)";
  environment.stderr.write(`${JSON.stringify({ notice })}\n`);
}

// why: remote mode needs a valid URL and a token before anything connects, for a command that connects (`connectFarm`) and for `simlock mcp`, which connects only on a tool call.
export async function checkedFarm(farm: RemoteFarm): Promise<{ url: string; token: string }> {
  const { checkedFarmUrl, FarmUrlError, farmTokenFits } =
    await import("../simlock-client/farm-url.js");
  let url: string;
  try {
    url = checkedFarmUrl(farm.url, "--url");
  } catch (error: unknown) {
    if (error instanceof FarmUrlError) throw new UsageError(error.message);
    throw error;
  }
  if (farm.token === undefined || !farmTokenFits(farm.token)) {
    throw new UsageError("No token: pass --token or set SIMLOCK_TOKEN");
  }
  return { token: farm.token, url };
}

// why: remote mode never falls back to an agent session or launches a daemon (ADR 0081 §3): the token decides the role, and there is no local daemon to fall back to.
async function connectFarm(
  environment: CliEnvironment,
  farm: RemoteFarm,
): Promise<SimlockAdminClient> {
  const [{ connectSimlockAdmin }, { token, url }] = await Promise.all([
    import("../admin/index.js"),
    checkedFarm(farm),
  ]);
  return connectSimlockAdmin({
    clock: environment.clock,
    token,
    url,
    webSocket: environment.webSocket,
  });
}

export async function connectDaemonClient(
  environment: CliEnvironment,
  tokenFlag: string | undefined,
  options: { readonly launch?: boolean; readonly untilStarted?: boolean } = {},
): Promise<SimlockAdminClient> {
  if (environment.remote !== undefined) return connectFarm(environment, environment.remote);
  const connect: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient> =
    options.launch === false
      ? environment.connectExistingAdmin
      : (resolveCredential) =>
          environment.connectAdmin(
            resolveCredential,
            options.untilStarted === true ? { untilStarted: true } : undefined,
          );

  let source: CredentialSource = "none";
  const resolveCredential = async (): Promise<string | undefined> => {
    if (tokenFlag !== undefined && tokenFlag !== "") {
      source = "flag";
      return tokenFlag;
    }
    if (environment.adminTokenFromEnv !== undefined && environment.adminTokenFromEnv !== "") {
      source = "env";
      return environment.adminTokenFromEnv;
    }
    const fileToken = await readAdminTokenFileWithRetry(environment);
    source = fileToken === undefined ? "none" : "file";
    return fileToken;
  };

  try {
    const client = await connect(resolveCredential);
    if (source === "none") writeAgentFallbackNotice(environment, "none");
    return client;
  } catch (error: unknown) {
    if (!(await isAdminAuthFailure(error)) || source === "none") throw error;
    writeAgentFallbackNotice(environment, source);
    return connect(async () => undefined);
  }
}
