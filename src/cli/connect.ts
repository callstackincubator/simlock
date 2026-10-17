import type { SimlockAdminClient } from "../admin/index.js";
import type { CliEnvironment } from "./types.js";

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

export async function connectDaemonClient(
  environment: CliEnvironment,
  tokenFlag: string | undefined,
  options: { readonly launch?: boolean } = {},
): Promise<SimlockAdminClient> {
  const connect =
    options.launch === false ? environment.connectExistingAdmin : environment.connectAdmin;

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
