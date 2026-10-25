// why: every import here is type-only -- a value import through this file would pull a whole
// component into the router's own load and break the lazy command tree.
import type { SimlockAdminClient } from "../admin/index.js";
import type { EventEnvelope } from "../bus/index.js";
import type { PassthroughCommand } from "../client/index.js";
import type { RunTool } from "../instructions/index.js";
import type {
  Clock,
  DaemonFlag,
  DaemonHome,
  DaemonLauncher,
  Filesystem,
  IpcConnector,
  ParentWatch,
  ServiceDefinition,
  ServiceManager,
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

export interface ServiceSetup {
  readonly manager: ServiceManager | undefined;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** why: read only where the linger hint needs it; the lookup throws for a uid with no passwd entry. */
  readonly user: () => string;
  readonly root: string;
  readonly nodePath: string;
  readonly mainPath: string;
}

export interface CliServiceAccess {
  readonly manager: ServiceManager | undefined;
  readonly platform: NodeJS.Platform;
  /** why: read only where the linger hint needs it; the lookup throws for a uid with no passwd entry. */
  readonly user: () => string;
  readonly definition: () => Promise<ServiceDefinition>;
}

export interface CliEnvironment {
  readonly clock: Clock;
  readonly configPath: string;
  readonly daemonHome: DaemonHome;
  readonly requesterId: string;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly codexHome?: string | undefined;
  readonly runTool: RunTool;
  readonly filesystem: Filesystem;
  readonly connectAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  readonly connectExistingAdmin: (
    resolveCredential: () => Promise<string | undefined>,
  ) => Promise<SimlockAdminClient>;
  /** why: a daemon stopping refuses connections while it still holds its socket; the endpoint going away is the proof it is gone. */
  readonly daemonEndpointPresent: () => Promise<boolean>;
  readonly adminTokenFromEnv?: string;
  readonly readAdminTokenFile: () => Promise<string | undefined>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readConfigFile: () => Promise<Record<string, unknown>>;
  readonly writeConfigFile: (contents: Record<string, unknown>) => Promise<void>;
  readonly validateConfig: (merged: Record<string, unknown>) => Promise<void>;
  readonly service?: CliServiceAccess;
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
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  readonly codexHome?: string | undefined;
  readonly runTool: RunTool;
  readonly service?: ServiceSetup;
  readonly parentWatch?: ParentWatch;
  readonly signals?: Signals;
  readonly stderr?: Output;
  readonly stdout?: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string | undefined>;
  readonly parentPid?: number;
}
