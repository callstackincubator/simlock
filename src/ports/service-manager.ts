import { createHash } from "node:crypto";
import { join } from "node:path";

import type { DaemonRole } from "./paths.js";
export type ServiceManagerName = "launchd" | "systemd";

export type ServiceState =
  | { readonly state: "not-installed" }
  | { readonly state: "installed" | "not-loaded"; readonly path: string }
  | { readonly state: "broken"; readonly path: string; readonly missing: readonly string[] };
export interface ServiceDefinition {
  readonly role: DaemonRole;
  readonly name: string;
  readonly path: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly logPath: string;
}

export interface ServiceDefinitionInput {
  readonly role: DaemonRole;
  readonly root: string;
  readonly dataDirectory: string;
  readonly home: string;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly env: NodeJS.ProcessEnv;
}

function homeHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 6);
}

export function serviceDefinition(input: ServiceDefinitionInput): ServiceDefinition {
  const base = `com.callstack.simlock.${input.role}`;
  const name =
    input.root === join(input.home, ".simlock") ? base : `${base}.${homeHash(input.root)}`;
  return {
    role: input.role,
    name,
    path: join(input.home, "Library", "LaunchAgents", `${name}.plist`),
    command: input.nodePath,
    args: [input.mainPath, ...(input.role === "gateway" ? ["--gateway"] : [])],
    environment: { SIMLOCK_HOME: input.root },
    logPath: join(input.dataDirectory, "daemon.log"),
  };
}

export interface ServiceManager {
  readonly manager: ServiceManagerName;
  state(definition: ServiceDefinition): Promise<ServiceState>;
  install(definition: ServiceDefinition): Promise<void>;
  uninstall(definition: ServiceDefinition): Promise<void>;
  start(definition: ServiceDefinition): Promise<void>;
}

export interface FakeServiceManagerOptions {
  readonly manager?: ServiceManagerName;
  readonly state?: ServiceState;
  readonly onInstall?: (definition: ServiceDefinition) => Promise<void> | void;
  readonly onStart?: (definition: ServiceDefinition) => Promise<void> | void;
}

export class FakeServiceManager implements ServiceManager {
  readonly manager: ServiceManagerName;
  readonly installs: ServiceDefinition[] = [];
  readonly uninstalls: ServiceDefinition[] = [];
  readonly starts: ServiceDefinition[] = [];
  current: ServiceState;

  constructor(private readonly options: FakeServiceManagerOptions = {}) {
    this.manager = options.manager ?? "launchd";
    this.current = options.state ?? { state: "not-installed" };
  }

  async state(): Promise<ServiceState> {
    return this.current;
  }

  async install(definition: ServiceDefinition): Promise<void> {
    this.installs.push(definition);
    this.current = { state: "installed", path: definition.path };
    await this.options.onInstall?.(definition);
  }

  async uninstall(definition: ServiceDefinition): Promise<void> {
    this.uninstalls.push(definition);
    this.current = { state: "not-installed" };
  }

  async start(definition: ServiceDefinition): Promise<void> {
    this.starts.push(definition);
    await this.options.onStart?.(definition);
  }
}
