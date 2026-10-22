import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

import type { Filesystem } from "./filesystem.js";
import type { DaemonRole } from "./paths.js";
import type { ProcessResult, ProcessRunner } from "./process-runner.js";
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
  readonly manager?: ServiceManagerName;
  readonly role: DaemonRole;
  readonly root: string;
  readonly dataDirectory: string;
  readonly home: string;
  readonly nodePath: string;
  readonly mainPath: string;
  readonly env: NodeJS.ProcessEnv;
}

const SAVED_VARIABLES = [
  "SIMLOCK_DRIVERS_MODULE",
  "PATH",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_AVD_HOME",
  "ANDROID_USER_HOME",
  "ANDROID_PREFS_ROOT",
  "ANDROID_SDK_HOME",
  "JAVA_HOME",
  "DEVELOPER_DIR",
] as const;

function homeHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 6);
}

function unitDirectory(input: ServiceDefinitionInput): string {
  const configured = input.env.XDG_CONFIG_HOME;
  const config =
    configured !== undefined && isAbsolute(configured) ? configured : join(input.home, ".config");
  return join(config, "systemd", "user");
}

export function serviceDefinition(input: ServiceDefinitionInput): ServiceDefinition {
  const environment: Record<string, string> = { SIMLOCK_HOME: input.root };
  for (const variable of SAVED_VARIABLES) {
    const value = input.env[variable];
    if (value !== undefined) environment[variable] = value;
  }
  const manager = input.manager ?? "launchd";
  const base = `com.callstack.simlock.${input.role}`;
  const name =
    input.root === join(input.home, ".simlock") ? base : `${base}.${homeHash(input.root)}`;
  return {
    role: input.role,
    name,
    path:
      manager === "systemd"
        ? join(unitDirectory(input), `${name}.service`)
        : join(input.home, "Library", "LaunchAgents", `${name}.plist`),
    command: input.nodePath,
    args: [input.mainPath, ...(input.role === "gateway" ? ["--gateway"] : [])],
    environment,
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

  // fallow-ignore-next-line unused-class-member -- called through the `ServiceManager` port.
  async install(definition: ServiceDefinition): Promise<void> {
    this.installs.push(definition);
    this.current = { state: "installed", path: definition.path };
    await this.options.onInstall?.(definition);
  }

  // fallow-ignore-next-line unused-class-member -- called through the `ServiceManager` port.
  async uninstall(definition: ServiceDefinition): Promise<void> {
    this.uninstalls.push(definition);
    this.current = { state: "not-installed" };
  }

  // fallow-ignore-next-line unused-class-member -- called through the `ServiceManager` port.
  async start(definition: ServiceDefinition): Promise<void> {
    this.starts.push(definition);
    await this.options.onStart?.(definition);
  }
}

export interface LaunchdServiceManagerOptions {
  readonly runner: ProcessRunner;
  readonly filesystem: Filesystem;
  readonly uid: number;
}

const LAUNCHCTL_TIMEOUT_MS = 10_000;
const STOP_LIMIT_SECONDS = 300;

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plistFor(definition: ServiceDefinition): string {
  const strings = (values: readonly string[]): string =>
    values.map((value) => `    <string>${xmlText(value)}</string>`).join("\n");
  const variables = Object.entries(definition.environment)
    .map(([key, value]) => `    <key>${xmlText(key)}</key>\n    <string>${xmlText(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlText(definition.name)}</string>
  <key>ProgramArguments</key>
  <array>
${strings([definition.command, ...definition.args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${String(STOP_LIMIT_SECONDS)}</integer>
  <key>StandardOutPath</key>
  <string>${xmlText(definition.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(definition.logPath)}</string>
</dict>
</plist>
`;
}

function savedPaths(json: string): readonly string[] {
  const parsed = JSON.parse(json) as { ProgramArguments?: unknown };
  const args = Array.isArray(parsed.ProgramArguments) ? (parsed.ProgramArguments as unknown[]) : [];
  return args.slice(0, 2).filter((value): value is string => typeof value === "string");
}

export class ServiceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceFailedError";
  }
}

function failure(command: string, args: readonly string[], result: ProcessResult): never {
  const commandLine = [command, ...args].join(" ");
  const reason = result.stderr.split("\n")[0] ?? "";
  throw new ServiceFailedError(`${commandLine} failed: ${reason}`);
}

function isExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function ensureLog(filesystem: Filesystem, logPath: string): Promise<void> {
  await filesystem.mkdirp(dirname(logPath));
  try {
    await filesystem.writeFileExclusive(logPath, "", { mode: 0o600 });
  } catch (error: unknown) {
    if (!isExistsError(error)) throw error;
  }
}

export class LaunchdServiceManager implements ServiceManager {
  readonly manager = "launchd";

  constructor(private readonly options: LaunchdServiceManagerOptions) {}

  private domain(): string {
    return `gui/${String(this.options.uid)}`;
  }

  private async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    const result = await this.options.runner.run(command, args, {
      timeoutMs: LAUNCHCTL_TIMEOUT_MS,
    });
    if (result.code === null) {
      throw new ServiceFailedError(`${[command, ...args].join(" ")} did not finish within 10 s`);
    }
    return result;
  }

  private launchctl(args: readonly string[]): Promise<ProcessResult> {
    return this.run("launchctl", args);
  }

  async state(definition: ServiceDefinition): Promise<ServiceState> {
    const { filesystem } = this.options;
    if (!(await filesystem.exists(definition.path))) return { state: "not-installed" };
    const convertArgs = ["-convert", "json", "-o", "-", definition.path];
    const converted = await this.run("plutil", convertArgs);
    if (converted.code !== 0) failure("plutil", convertArgs, converted);
    const saved = savedPaths(converted.stdout);
    const missing: string[] = [];
    for (const path of saved) if (!(await filesystem.exists(path))) missing.push(path);
    if (missing.length > 0) return { state: "broken", path: definition.path, missing };
    const printed = await this.launchctl(["print", `${this.domain()}/${definition.name}`]);
    return { state: printed.code === 0 ? "installed" : "not-loaded", path: definition.path };
  }

  async install(definition: ServiceDefinition): Promise<void> {
    const { filesystem } = this.options;
    await this.launchctl(["bootout", `${this.domain()}/${definition.name}`]);
    await ensureLog(filesystem, definition.logPath);
    await filesystem.mkdirp(dirname(definition.path));
    await filesystem.writeFileAtomic(definition.path, plistFor(definition));
    const bootstrapArgs = ["bootstrap", this.domain(), definition.path];
    let loaded: ProcessResult | undefined;
    try {
      loaded = await this.launchctl(bootstrapArgs);
    } finally {
      if (loaded?.code !== 0) await filesystem.rm(definition.path);
    }
    if (loaded.code !== 0) failure("launchctl", bootstrapArgs, loaded);
  }

  async uninstall(definition: ServiceDefinition): Promise<void> {
    await this.launchctl(["bootout", `${this.domain()}/${definition.name}`]);
    await this.options.filesystem.rm(definition.path);
  }

  async start(definition: ServiceDefinition): Promise<void> {
    const args = ["kickstart", `${this.domain()}/${definition.name}`];
    const started = await this.launchctl(args);
    if (started.code !== 0) failure("launchctl", args, started);
  }
}

export interface SystemdServiceManagerOptions {
  readonly runner: ProcessRunner;
  readonly filesystem: Filesystem;
}

function unitFor(definition: ServiceDefinition): string {
  const variables = Object.entries(definition.environment)
    .map(([key, value]) => `Environment="${key}=${value}"`)
    .join("\n");
  return `[Unit]
Description=simlock ${definition.role} daemon
StartLimitIntervalSec=0

[Service]
ExecStart=${[definition.command, ...definition.args].join(" ")}
${variables}
Restart=on-failure
RestartSec=10
KillMode=process
TimeoutStopSec=${String(STOP_LIMIT_SECONDS)}
StandardOutput=append:${definition.logPath}
StandardError=append:${definition.logPath}

[Install]
WantedBy=default.target
`;
}

function savedUnitPaths(unit: string): readonly string[] {
  const line = unit.split("\n").find((candidate) => candidate.startsWith("ExecStart="));
  return (line?.slice("ExecStart=".length).trim().split(/\s+/) ?? [])
    .slice(0, 2)
    .filter((path) => path !== "");
}

export class SystemdServiceManager implements ServiceManager {
  readonly manager = "systemd";

  constructor(private readonly options: SystemdServiceManagerOptions) {}

  private async systemctl(args: readonly string[]): Promise<ProcessResult> {
    const userArgs = ["--user", ...args];
    let result: ProcessResult;
    try {
      result = await this.options.runner.run("systemctl", userArgs, {
        timeoutMs: LAUNCHCTL_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceFailedError(`systemctl ${userArgs.join(" ")} failed: ${reason}`);
    }
    if (result.code === null) {
      throw new ServiceFailedError(`systemctl ${userArgs.join(" ")} did not finish within 10 s`);
    }
    return result;
  }

  private async checked(args: readonly string[]): Promise<void> {
    const result = await this.systemctl(args);
    if (result.code !== 0) failure("systemctl", ["--user", ...args], result);
  }

  async state(definition: ServiceDefinition): Promise<ServiceState> {
    const { filesystem } = this.options;
    if (!(await filesystem.exists(definition.path))) return { state: "not-installed" };
    const saved = savedUnitPaths(await filesystem.readFile(definition.path));
    if (saved.length === 0) {
      return { state: "broken", path: definition.path, missing: [definition.path] };
    }
    const missing: string[] = [];
    for (const path of saved) if (!(await filesystem.exists(path))) missing.push(path);
    if (missing.length > 0) return { state: "broken", path: definition.path, missing };
    const enabled = await this.systemctl(["is-enabled", `${definition.name}.service`]).catch(
      () => undefined,
    );
    const loaded = enabled?.code === 0 && enabled.stdout.trim() === "enabled";
    return { state: loaded ? "installed" : "not-loaded", path: definition.path };
  }

  async install(definition: ServiceDefinition): Promise<void> {
    const { filesystem } = this.options;
    await ensureLog(filesystem, definition.logPath);
    await filesystem.mkdirp(dirname(definition.path));
    await filesystem.writeFileAtomic(definition.path, unitFor(definition));
    try {
      await this.checked(["daemon-reload"]);
      await this.checked(["enable", "--now", `${definition.name}.service`]);
    } catch (error: unknown) {
      await filesystem.rm(definition.path);
      throw error;
    }
  }

  async uninstall(definition: ServiceDefinition): Promise<void> {
    await this.checked(["disable", "--now", `${definition.name}.service`]);
    const { filesystem } = this.options;
    const text = await filesystem.readFile(definition.path);
    await filesystem.rm(definition.path);
    try {
      await this.checked(["daemon-reload"]);
    } catch (error: unknown) {
      await filesystem.writeFileAtomic(definition.path, text);
      throw error;
    }
  }

  async start(definition: ServiceDefinition): Promise<void> {
    await this.checked(["start", `${definition.name}.service`]);
  }
}

export function productionServiceManager(
  platform: NodeJS.Platform,
  dependencies: {
    readonly runner: ProcessRunner;
    readonly filesystem: Filesystem;
    readonly uid: number;
  },
): ServiceManager | undefined {
  if (platform === "linux") return new SystemdServiceManager(dependencies);
  return platform === "darwin" ? new LaunchdServiceManager(dependencies) : undefined;
}
