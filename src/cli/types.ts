// why: every import here is type-only -- a value import through this file would pull a whole
// component into the router's own load and break the lazy command tree.
import type { SimlockAdminClient } from "../admin/index.js";
import type { EventEnvelope } from "../bus/index.js";
import type { PassthroughCommand } from "../client/index.js";
import type {
  Clock,
  DaemonFlag,
  DaemonHome,
  DaemonLauncher,
  Filesystem,
  IpcConnector,
  ParentWatch,
  SystemStats,
} from "../ports/index.js";

export interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface Output {
  write(value: string): unknown;
}

/** why: the CLI's own shape for "start the stdio MCP server and run until it closes";
 * `src/mcp/main.ts` has a runner of the same job under the same name and a different shape, so
 * this one is named for what the CLI holds rather than shared, which would couple the two. */
export type McpStdioLauncher = (options: { readonly daemonFlag: DaemonFlag }) => Promise<void>;

export interface CliEnvironment {
  readonly clock: Clock;
  readonly configPath: string;
  readonly daemonHome: DaemonHome;
  readonly requesterId: string;
  readonly connectAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  readonly connectExistingAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  readonly adminTokenFromEnv?: string;
  readonly readAdminTokenFile: () => Promise<string | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
  readonly validateConfig: (merged: Record<string, unknown>) => Promise<void>;
  readonly readLogFile?: () => Promise<string>;
  readonly followLogFile?: () => Promise<void>;
  readonly readEventHistory: (sinceTs: number) => Promise<readonly EventEnvelope[]>;
  readonly loadMcpStdio?: () => Promise<McpStdioLauncher>;
  readonly runMcpStdio?: McpStdioLauncher;
  readonly signals: Signals;
  readonly parentPid?: number;
  readonly parentWatch?: ParentWatch;
  readonly stderr: Output;
  readonly stdout: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string | undefined>;
}

export interface CliEnvironmentPorts {
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly systemStats: SystemStats;
  readonly ipc: IpcConnector;
  readonly launcher: DaemonLauncher;
  readonly daemonHome: DaemonHome;
  readonly parentWatch?: ParentWatch;
  readonly signals?: Signals;
  readonly stderr?: Output;
  readonly stdout?: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string | undefined>;
  readonly parentPid?: number;
}
