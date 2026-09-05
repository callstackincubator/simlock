import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SimlockClient } from "../client/index.js";
import {
  NodeDaemonLauncher,
  NodeIpcTransport,
  resolveSimlockHome,
  SystemClock,
  type Clock,
} from "../ports/index.js";
import { connectToRunningDaemon, connectWithAutoLaunch } from "./connect.js";
import { McpSession } from "./session.js";
import { createMcpServer } from "./server.js";

interface Signals {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

interface StdinLifecycle {
  off(event: "end", listener: () => void): unknown;
  once(event: "end", listener: () => void): unknown;
  readonly readableEnded?: boolean;
}

/** The runner needs only the lifecycle portion of the SDK transport contract. */
export interface McpTransport {
  close(): Promise<void>;
  onclose?: () => void;
}

export interface McpStdioEnvironment {
  /** The `Clock` the session's renew timer runs on; a real one unless a test injects otherwise. */
  readonly clock?: Clock;
  readonly connect?: () => Promise<SimlockClient>;
  /** The renew timer's connect (ADR 0004 §2) -- never launches a daemon. Defaults alongside
   * `connect`; a test that injects one usually injects both. */
  readonly connectForRenew?: () => Promise<SimlockClient>;
  readonly createServer?: (session: McpSession) => McpServer;
  readonly createTransport?: () => McpTransport;
  /** Source for `SIMLOCK_AGENT_ID` when `requesterId` is not given explicitly. */
  readonly env?: NodeJS.ProcessEnv;
  readonly requesterId?: string;
  readonly signals?: Signals;
  /** The stdio transport currently does not surface stdin EOF as onclose. */
  readonly stdin?: StdinLifecycle;
}

export interface McpStdioRunner {
  readonly shutdown: () => Promise<void>;
  readonly finished: Promise<void>;
}

/**
 * Connects the MCP server to stdio and remains pending until the connection closes.
 * The caller owns process exit status and any fatal diagnostic rendering.
 */
// fallow-ignore-next-line unused-export -- CLI routing invokes this public frontend entrypoint.
export async function runMcpStdio(environment: McpStdioEnvironment = {}): Promise<void> {
  const runner = await startMcpStdio(environment);
  await runner.finished;
}

/** Starts an injectable MCP stdio lifecycle; primarily useful to integration-test shutdown. */
export async function startMcpStdio(
  environment: McpStdioEnvironment = {},
): Promise<McpStdioRunner> {
  const env = environment.env ?? process.env;
  const requesterId = environment.requesterId ?? env.SIMLOCK_AGENT_ID ?? `mcp:${process.pid}`;
  // One `Clock` for the whole frontend: the session's renew timer and the auto-launch retry
  // loop must not be able to disagree about what time it is (architecture rule 9).
  const clock = environment.clock ?? new SystemClock();
  const defaults = defaultEnvironment(requesterId, clock);
  const session = new McpSession({
    clock,
    connect: environment.connect ?? defaults.connect,
    connectForRenew: environment.connectForRenew ?? environment.connect ?? defaults.connectForRenew,
  });
  const server = (environment.createServer ?? createMcpServer)(session);
  const transport = (environment.createTransport ?? defaults.createTransport)();
  const signals = environment.signals ?? process;
  const stdin = environment.stdin ?? process.stdin;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  // Guards synchronous re-entrancy, not just repeated calls after the fact: the SDK's
  // own transport.close() can invoke `onclose` synchronously, inside the same call
  // stack that reaches it via `server.close()` below -- at that point `shutdownPromise
  // ??= ...` has not finished assigning yet (the assignment happens only after the IIFE
  // it calls returns a promise), so a plain `??=` guard re-enters and recurses until the
  // stack overflows. Setting this flag as the very first synchronous statement closes
  // that window: a re-entrant call sees it immediately and returns `shutdownPromise` as
  // it stands (possibly still `undefined` at that exact instant, which is fine -- the
  // caller that reached us via `onclose` doesn't await the result).
  let shuttingDown = false;
  let serverConnectStarted = false;

  const onSignal = () => {
    void shutdown();
  };
  const onStdinEnd = () => {
    void shutdown();
  };
  const previousTransportOnClose = transport.onclose;
  transport.onclose = () => {
    previousTransportOnClose?.();
    void shutdown();
  };
  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shutdownPromise ?? Promise.resolve();
    shuttingDown = true;
    shutdownPromise = (async () => {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      stdin.off("end", onStdinEnd);
      // McpServer owns its transport once connect starts; its close() closes the
      // transport and fires onclose. Close a never-connected transport ourselves.
      await Promise.allSettled([
        session.close(),
        server.close(),
        ...(serverConnectStarted ? [] : [transport.close()]),
      ]);
      resolveFinished();
    })();
    return shutdownPromise;
  };

  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  stdin.once("end", onStdinEnd);
  if (stdin.readableEnded) {
    await shutdown();
    return { finished, shutdown };
  }
  try {
    serverConnectStarted = true;
    await server.connect(transport as never);
  } catch (error: unknown) {
    await shutdown();
    throw error;
  }

  return { finished, shutdown };
}

function defaultEnvironment(
  requesterId: string,
  clock: Clock,
): Required<Pick<McpStdioEnvironment, "connect" | "connectForRenew" | "createTransport">> {
  const dataDirectory = resolveSimlockHome();
  const ipc = new NodeIpcTransport();
  const socketPath = join(dataDirectory, "daemon.sock");
  const logPath = join(dataDirectory, "daemon.log");
  return {
    // The tool-call trigger: auto-launches a daemon that is not running, exactly as the CLI
    // does. ADR 0004 §2/§4: the session keeps its lease alive with its own `lease.renew` timer
    // and releases explicitly when the agent goes away (stdin EOF -> session.close()), so it
    // declares no daemon-initiated heartbeat -- there is none left to declare.
    connect: () =>
      connectWithAutoLaunch({
        clock,
        ipc,
        launcher: new NodeDaemonLauncher({
          args: [join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js")],
          command: process.execPath,
          logPath,
          simlockHome: dataDirectory,
        }),
        principal: requesterId,
        socketPath,
      }),
    // The renew timer's trigger: connects to a daemon that is already listening and never
    // launches one, so an operator's `simlock daemon stop` is not undone by an idle session
    // (ADR 0004 §2).
    connectForRenew: () => connectToRunningDaemon({ ipc, principal: requesterId, socketPath }),
    createTransport: () => new StdioServerTransport(),
  };
}
