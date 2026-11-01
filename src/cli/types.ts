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
  HttpJsonClient,
  IpcConnector,
  ParentWatch,
  ServiceDefinition,
  ServiceManager,
  SystemStats,
  TcpListenerFactory,
  TcpStreamConnector,
  WebSocketClientConnector,
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
  /** why: `setup` lists iOS in its machine summary only on a macOS host, where the daemon has an iOS driver. */
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly runTool: RunTool;
  readonly filesystem: Filesystem;
  /** why: `untilStarted` makes a launch return only once the daemon has left `starting`, so a start that fails after its first answer is reported as the daemon's own error. */
  readonly connectAdmin: (
    resolveCredential: () => Promise<string | undefined>,
    options?: { readonly untilStarted?: boolean },
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
  /** why: `simlock tunnel` reaches a worker or gateway over HTTP and WebSocket, not the daemon's socket; each port loads its adapter on first use. */
  readonly webSocket: WebSocketClientConnector;
  readonly httpJson: HttpJsonClient;
  readonly tcpStreams: TcpStreamConnector;
  /** why: a `forward` tunnel listens on the caller's loopback port; the adapter loads on first use. */
  readonly tcpListeners: TcpListenerFactory;
  /** why: `SIMLOCK_URL` and `SIMLOCK_TOKEN` name the daemon `simlock tunnel` calls and the credential it sends. */
  readonly tunnelUrl?: string;
  readonly tunnelToken?: string;
  readonly readStdin?: () => Promise<string>;
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
  readonly hostPlatform?: NodeJS.Platform | undefined;
  readonly runTool: RunTool;
  readonly service?: ServiceSetup;
  readonly parentWatch?: ParentWatch;
  readonly signals?: Signals;
  readonly stderr?: Output;
  readonly stdout?: Output;
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  readonly runPassthrough?: (command: PassthroughCommand) => Promise<number>;
  readonly readStdin?: () => Promise<string>;
  readonly parentPid?: number;
  readonly webSocket?: WebSocketClientConnector;
  readonly httpJson?: HttpJsonClient;
  readonly tcpStreams?: TcpStreamConnector;
  readonly tcpListeners?: TcpListenerFactory;
}
