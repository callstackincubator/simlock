import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { join } from "node:path";

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
  const session = new McpSession({
    connect: environment.connect ?? defaults.connect,
    requesterId: environment.requesterId ?? `mcp:${process.pid}`,
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

  const onSignal = () => {
    void shutdown();
  };
  const onStdinEnd = () => {
    void shutdown();
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      stdin.off("end", onStdinEnd);
      await Promise.allSettled([session.close(), server.close(), transport.close()]);
      resolveFinished();
    })();
    return shutdownPromise;
  };

  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  stdin.once("end", onStdinEnd);
  try {
    await server.connect(transport as never);
    const serverOnClose = transport.onclose;
    transport.onclose = () => {
      serverOnClose?.();
      void shutdown();
    };
  } catch (error: unknown) {
    await shutdown();
    throw error;
  }

  return { finished, shutdown };
}

function defaultEnvironment(): Required<Pick<McpStdioEnvironment, "connect" | "createTransport">> {
  const dataDirectory = join(homedir(), ".pitlane");
  return {
    connect: () => connectDaemon({ dataDirectory, socketPath: join(dataDirectory, "daemon.sock") }),
    createTransport: () => new StdioServerTransport(),
  };
}
