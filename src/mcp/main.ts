import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NodeDaemonLauncher,
  NodeIpcTransport,
  resolveDaemonSocketPath,
  resolveSimlockHome,
  SystemClock,
} from "../ports/index.js";
import { connectDaemon } from "../daemon-client/client.js";
import type { DaemonConnection } from "../daemon-client/protocol.js";
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
  readonly connect?: () => Promise<DaemonConnection>;
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
  const defaults = defaultEnvironment();
  const env = environment.env ?? process.env;
  const session = new McpSession({
    connect: environment.connect ?? defaults.connect,
    requesterId: environment.requesterId ?? env.SIMLOCK_AGENT_ID ?? `mcp:${process.pid}`,
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

function defaultEnvironment(): Required<Pick<McpStdioEnvironment, "connect" | "createTransport">> {
  const dataDirectory = resolveSimlockHome();
  const clock = new SystemClock();
  const ipc = new NodeIpcTransport();
  const socketPath = resolveDaemonSocketPath(dataDirectory);
  const logPath = join(dataDirectory, "daemon.log");
  return {
    connect: () =>
      connectDaemon({
        // MCP's holder process dies with its agent (stdin EOF -> session.close()), so a
        // sliding TTL is safe here. CLI held mode declares the same capability now that
        // it self-terminates on parent death too — see docs/known-pitfalls.md.
        capabilities: { heartbeat: true },
        clock,
        ipc,
        launcher: new NodeDaemonLauncher({
          args: [join(dirname(fileURLToPath(import.meta.url)), "../daemon/main.js")],
          command: process.execPath,
          logPath,
          simlockHome: dataDirectory,
        }),
        socketPath,
      }),
    createTransport: () => new StdioServerTransport(),
  };
}
