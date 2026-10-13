import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cli, cliBackground, type CliBackgroundHandle } from "./cli.js";
import type { SharedTestEnv } from "./env.js";
import { waitFor } from "./wait.js";

export interface AgentDeviceResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: unknown;
  readonly data: unknown;
  readonly error: { code: string; message: string; details?: Record<string, unknown> } | undefined;
}

export interface AgentDeviceRunOptions {
  readonly timeout?: number;
}

export interface Agent {
  readonly name: string;
  readonly home: string;
  readonly token: string;
  readonly tokenId: string;
  run(args: readonly string[], options?: AgentDeviceRunOptions): Promise<AgentDeviceResult>;
  start(args: readonly string[]): CliBackgroundHandle;
}

interface MadeAgent {
  readonly env: SharedTestEnv;
  readonly agent: Agent;
  readonly background: Set<CliBackgroundHandle>;
}

const made: MadeAgent[] = [];

function agentDeviceEntry(): string {
  const entry = process.env.SIMLOCK_E2E_AGENT_DEVICE;
  if (entry === undefined || entry === "") throw new Error("SIMLOCK_E2E_AGENT_DEVICE is not set");
  return entry;
}

function proxyUrl(env: SharedTestEnv): string {
  return `http://127.0.0.1:${env.httpPort}/v1/agent-device`;
}

export async function newAgentToken(env: SharedTestEnv): Promise<{ secret: string; id: string }> {
  const created = await env.cli(["token", "create", "--role", "agent"], { timeout: 60_000 });
  if (created.code !== 0) throw new Error(`simlock token create failed: ${created.stderr}`);
  const body = created.json as { token: { id: string }; secret: string };
  return { secret: body.secret, id: body.token.id };
}

function parseResult(code: number | null, stdout: string, stderr: string): AgentDeviceResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    json = undefined;
  }
  const envelope = json as
    | { data?: unknown; error?: AgentDeviceResult["error"] }
    | null
    | undefined;
  const record = typeof envelope === "object" && envelope !== null ? envelope : undefined;
  return { code, stdout, stderr, json, data: record?.data, error: record?.error };
}

export async function makeAgent(env: SharedTestEnv, name: string): Promise<Agent> {
  const token = await newAgentToken(env);
  const home = await mkdtemp(join(tmpdir(), `simlock-ad-${name}-`));
  const entry = agentDeviceEntry();
  // why: a developer's own AGENT_DEVICE_* settings must never point an agent at their own daemon.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_DEVICE_")),
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    AGENT_DEVICE_STATE_DIR: home,
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: token.secret,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  };
  const background = new Set<CliBackgroundHandle>();
  const agent: Agent = {
    name,
    home,
    token: token.secret,
    tokenId: token.id,
    async run(args, options = {}) {
      const result = await cli(["--json", ...args], childEnv, {
        entry,
        timeout: options.timeout ?? 120_000,
      });
      return parseResult(result.code, result.stdout, result.stderr);
    },
    start(args) {
      const handle = cliBackground(["--json", ...args], childEnv, { entry });
      background.add(handle);
      return handle;
    },
  };
  made.push({ env, agent, background });
  const connected = await agent.run(["connect", "proxy", "--daemon-base-url", proxyUrl(env)]);
  if (connected.code !== 0) {
    throw new Error(`agent-device connect proxy failed: ${connected.stdout}\n${connected.stderr}`);
  }
  return agent;
}

export async function cleanupAgents(): Promise<void> {
  const agents = made.splice(0);
  await Promise.allSettled(
    agents.map(async ({ env, agent, background }) => {
      for (const handle of background) handle.kill("SIGKILL");
      await Promise.all(
        [...background].map((handle) => handle.waitForExit(10_000).catch(() => undefined)),
      );
      await agent.run(["disconnect"], { timeout: 60_000 }).catch(() => undefined);
      await env.cli(["token", "revoke", agent.tokenId], { timeout: 30_000 }).catch(() => undefined);
      await rm(agent.home, { force: true, recursive: true });
    }),
  );
}

export async function waitForAgentDevice(env: SharedTestEnv, token: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${proxyUrl(env)}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status !== 200) return false;
        const body = (await response.json()) as { ok?: unknown };
        return body.ok === true;
      } catch {
        return false;
      }
    },
    { timeout: 60_000, interval: 500, label: "the agent-device daemon answers /health" },
  );
}
