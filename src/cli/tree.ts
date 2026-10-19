// why: a node names its implementer as a thunk instead of an import, so `simlock <node>` loads
// its module and nothing else; a parent whose children share one implementation points them at
// one `load` (the ESM cache makes the repeat free) and hands the consumed words down as `path`,
// so a parent branches without its module ever being imported by the router.
import type { CliEnvironment } from "./types.js";

export interface CommandContext {
  readonly path: readonly string[];
  readonly environment: CliEnvironment;
  readonly token: string | undefined;
}

export interface CommandModule {
  run(argv: readonly string[], context: CommandContext): Promise<number>;
}

export interface CommandNode {
  readonly name: string;
  readonly load: () => Promise<CommandModule>;
  readonly children?: readonly CommandNode[];
}

export async function resolveCommand(
  nodes: readonly CommandNode[],
  argv: readonly string[],
): Promise<
  | {
      readonly module: CommandModule;
      readonly path: readonly string[];
      readonly rest: readonly string[];
    }
  | undefined
> {
  let matching: CommandNode | undefined = nodes.find((node) => node.name === argv[0]);
  if (matching === undefined) return undefined;
  const path: string[] = [matching.name];
  for (;;) {
    const child: CommandNode | undefined = matching.children?.find(
      (candidate) => candidate.name === argv[path.length],
    );
    if (child === undefined) break;
    matching = child;
    path.push(child.name);
  }
  return { module: await matching.load(), path, rest: argv.slice(path.length) };
}

const daemonModule = () => import("./commands/daemon.js");
const deviceModule = () => import("./commands/device.js");
const configModule = () => import("./commands/config.js");
const leaseModule = () => import("./commands/lease.js");
const tokenModule = () => import("./commands/token.js");
const workerModule = () => import("./commands/worker.js");
const componentModule = () => import("./commands/component.js");

export const COMMANDS: readonly CommandNode[] = [
  { name: "lease", load: leaseModule, children: [{ name: "renew", load: leaseModule }] },
  { name: "release", load: () => import("./commands/release.js") },
  { name: "status", load: () => import("./commands/status.js") },
  { name: "list", load: () => import("./commands/list.js") },
  { name: "catalog", load: () => import("./commands/catalog.js") },
  { name: "cleanup", load: () => import("./commands/cleanup.js") },
  { name: "doctor", load: () => import("./commands/doctor.js") },
  { name: "nuke", load: () => import("./commands/nuke.js") },
  { name: "events", load: () => import("./commands/events.js") },
  { name: "stats", load: () => import("./commands/stats.js") },
  {
    name: "daemon",
    load: daemonModule,
    children: [
      { name: "start", load: daemonModule },
      { name: "stop", load: daemonModule },
      { name: "status", load: daemonModule },
      { name: "logs", load: daemonModule },
    ],
  },
  {
    name: "config",
    load: configModule,
    children: [
      { name: "get", load: configModule },
      { name: "set", load: configModule },
    ],
  },
  {
    name: "token",
    load: tokenModule,
    children: [
      { name: "create", load: tokenModule },
      { name: "list", load: tokenModule },
      { name: "revoke", load: tokenModule },
    ],
  },
  {
    name: "worker",
    load: workerModule,
    children: [
      { name: "list", load: workerModule },
      { name: "drain", load: workerModule },
      { name: "undrain", load: workerModule },
      { name: "remove", load: workerModule },
    ],
  },
  {
    name: "component",
    load: componentModule,
    children: [
      { name: "install", load: componentModule },
      { name: "list", load: componentModule },
      { name: "remove", load: componentModule },
    ],
  },
  {
    name: "device",
    load: deviceModule,
    children: [
      { name: "add", load: deviceModule },
      { name: "remove", load: deviceModule },
    ],
  },
  { name: "simctl", load: () => import("./commands/passthrough.js") },
  { name: "adb", load: () => import("./commands/passthrough.js") },
  { name: "mcp", load: () => import("./commands/mcp.js") },
];
