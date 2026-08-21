import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  type LoggingMessageNotification,
  type ProgressNotification,
} from "@modelcontextprotocol/sdk/types.js";

import { REPO_ROOT } from "./repo-root.js";

const CLI_ENTRY = join(REPO_ROOT, "dist/cli/main.js");

export interface McpClientOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export interface McpClientHandle {
  readonly client: Client;
  /** `notifications/progress` frames received so far, in order. */
  progressNotifications(): readonly ProgressNotification["params"][];
  /** `notifications/message` (logging) frames received so far, in order. */
  loggingNotifications(): readonly LoggingMessageNotification["params"][];
  waitForNotification<T>(
    predicate: (
      notification:
        | { readonly kind: "progress"; readonly params: ProgressNotification["params"] }
        | { readonly kind: "logging"; readonly params: LoggingMessageNotification["params"] },
    ) => T | undefined,
    timeout?: number,
  ): Promise<T>;
  /**
   * The `simlock mcp` subprocess's stderr captured so far. Piped (not inherited) so a
   * subprocess shutdown quirk (see the flow-2 report note on a stack-overflow logged
   * during teardown) does not spam the test runner's own output; available here for
   * a test that needs to inspect it.
   */
  stderrOutput(): string;
  close(): Promise<void>;
}

/**
 * Spawns `node dist/cli/main.js mcp` and connects a real SDK `Client` over stdio,
 * with progress/logging notification sinks pre-wired so tests can assert MCP
 * framing in one place instead of re-registering handlers per test.
 */
export async function mcpClient(
  env: NodeJS.ProcessEnv,
  options: McpClientOptions = {},
): Promise<McpClientHandle> {
  let stderrOutput = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp"],
    // StdioClientTransport only inherits a safe-listed subset of process.env by
    // default (DEFAULT_INHERITED_ENV_VARS) -- explicit here so SIMLOCK_HOME /
    // SIMLOCK_DRIVERS_MODULE / SIMLOCK_AGENT_ID actually reach the spawned process.
    env: toStringEnv({ ...env, ...options.env }),
    // Piped (not the default "inherit") so a subprocess shutdown quirk doesn't spam
    // the test runner's own stderr; captured instead, see `stderrOutput()`.
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString("utf8");
  });
  const client = new Client({ name: "simlock-e2e", version: "0.0.0" });

  const progress: ProgressNotification["params"][] = [];
  const logging: LoggingMessageNotification["params"][] = [];
  const waiters: {
    predicate: (notification: { kind: "progress" | "logging"; params: unknown }) => unknown;
    resolve: (value: unknown) => void;
  }[] = [];

  function dispatch(notification: { kind: "progress" | "logging"; params: unknown }): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined) continue;
      const result = waiter.predicate(notification);
      if (result !== undefined) {
        waiters.splice(index, 1);
        waiter.resolve(result);
      }
    }
  }

  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    progress.push(notification.params);
    dispatch({ kind: "progress", params: notification.params });
  });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logging.push(notification.params);
    dispatch({ kind: "logging", params: notification.params });
  });

  await client.connect(transport);
  let closed = false;

  return {
    client,
    progressNotifications: () => [...progress],
    loggingNotifications: () => [...logging],
    stderrOutput: () => stderrOutput,
    waitForNotification(predicate, timeout = 30_000) {
      // Check what has already arrived first -- a notification can beat the caller
      // to `waitForNotification` (e.g. the action that triggers it and the call to
      // this method are two separate awaits), and only dispatching to *future*
      // arrivals would make that a race instead of a wait.
      for (const params of progress) {
        const result = predicate({ kind: "progress", params });
        if (result !== undefined) return Promise.resolve(result as never);
      }
      for (const params of logging) {
        const result = predicate({ kind: "logging", params });
        if (result !== undefined) return Promise.resolve(result as never);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out after ${timeout}ms waiting for a matching MCP notification`));
        }, timeout);
        waiters.push({
          predicate: (notification) => predicate(notification as never),
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as never);
          },
        });
      });
    },
    async close() {
      // Idempotent: both a test's own cleanup and TestEnv's teardown safety net may
      // call this on the same handle.
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
