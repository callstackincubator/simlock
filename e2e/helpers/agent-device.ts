import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { afterEach } from "vitest";

import { cli, cliBackground, type CliBackgroundHandle } from "./cli.js";
import type { SharedTestEnv } from "./env.js";
import { REPO_ROOT } from "./repo-root.js";
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
  // why: the profile token belongs to the worker, not to the agent, so cleanup leaves it.
  readonly keepToken?: boolean;
}

const made: MadeAgent[] = [];

function agentDeviceEntry(): string {
  const entry = process.env.SIMLOCK_E2E_AGENT_DEVICE;
  if (entry === undefined || entry === "") throw new Error("SIMLOCK_E2E_AGENT_DEVICE is not set");
  return entry;
}

// why: the slow lane must run the agent-device release whose proxy simlock bundles, so the version package.json pins for @agent-device/proxy is the one it accepts.
export async function assertPinnedAgentDevice(
  platform: "ios" | "android" = "ios",
): Promise<string> {
  const entry = agentDeviceEntry();
  if (!isAbsolute(entry) || !existsSync(entry)) {
    throw new Error(
      `SIMLOCK_E2E_AGENT_DEVICE ${entry} is not an absolute path to an existing file`,
    );
  }
  const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const pinned = manifest.dependencies?.["@agent-device/proxy"];
  if (pinned === undefined || !/^\d+\.\d+\.\d+$/.test(pinned))
    throw new Error("package.json does not pin @agent-device/proxy");
  const actual = execFileSync(process.execPath, [entry, "--version"], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
  if (actual !== pinned) {
    throw new Error(
      `SIMLOCK_E2E_AGENT_DEVICE ${entry} is version ${actual}, package.json pins ${pinned}`,
    );
  }
  if (platform === "android") {
    // why: an Android snapshot needs the helper APK the npm package ships and a checkout builds with `pnpm build:android`; without it every snapshot fails mid-test.
    const manifest = join(
      dirname(entry),
      "..",
      "android",
      "snapshot-helper",
      "dist",
      `agent-device-android-snapshot-helper-${actual}.manifest.json`,
    );
    if (!existsSync(manifest)) {
      throw new Error(
        `the Android snapshot helper is missing (${manifest}); install agent-device ${actual} from npm, or run \`pnpm build:android\` with ANDROID_HOME set in the agent-device checkout`,
      );
    }
  }
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
        timeout: options.timeout ?? 60_000,
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

const PROFILE_TOKEN_LABEL = "agent-device on this Mac";

// why: the agent a local user is, per ADR 0046: no token in its environment, the worker's profile file named once at connect, and its own --session on every command.
export async function makeProfileAgent(env: SharedTestEnv, name: string): Promise<Agent> {
  const profilePath = join(env.dataDirectory, "agent-device-profile.json");
  const secret = (JSON.parse(await readFile(profilePath, "utf8")) as { daemonAuthToken: string })
    .daemonAuthToken;
  const listed = await env.cli(["token", "list"], { timeout: 60_000 });
  const labelled = (
    listed.json as { tokens: readonly { id: string; label?: string }[] }
  ).tokens.filter((token) => token.label === PROFILE_TOKEN_LABEL);
  const tokenId = labelled[0]?.id;
  if (labelled.length !== 1 || tokenId === undefined) {
    throw new Error(
      `expected one "${PROFILE_TOKEN_LABEL}" token, found ${String(labelled.length)}`,
    );
  }
  const home = await mkdtemp(join(tmpdir(), `simlock-ad-${name}-`));
  const entry = agentDeviceEntry();
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AGENT_DEVICE_")),
  );
  const childEnv: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    AGENT_DEVICE_STATE_DIR: home,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  };
  const background = new Set<CliBackgroundHandle>();
  const agent: Agent = {
    name,
    home,
    token: secret,
    tokenId,
    async run(args, options = {}) {
      const result = await cli(["--json", ...args, "--session", name], childEnv, {
        entry,
        timeout: options.timeout ?? 60_000,
      });
      return parseResult(result.code, result.stdout, result.stderr);
    },
    start(args) {
      const handle = cliBackground(["--json", ...args, "--session", name], childEnv, { entry });
      background.add(handle);
      return handle;
    },
  };
  made.push({ env, agent, background, keepToken: true });
  const connected = await agent.run(["connect", "--remote-config", profilePath]);
  if (connected.code !== 0) {
    throw new Error(`agent-device connect failed: ${connected.stdout}\n${connected.stderr}`);
  }
  return agent;
}

export async function cleanupAgents(): Promise<void> {
  const agents = made.splice(0);
  await Promise.allSettled(
    agents.map(async ({ env, agent, background, keepToken }) => {
      for (const handle of background) handle.kill("SIGKILL");
      await Promise.all(
        [...background].map((handle) => handle.waitForExit(10_000).catch(() => undefined)),
      );
      await agent.run(["disconnect"], { timeout: 60_000 }).catch(() => undefined);
      if (keepToken !== true) {
        await env
          .cli(["token", "revoke", agent.tokenId], { timeout: 30_000 })
          .catch(() => undefined);
      }
      await rm(agent.home, { force: true, recursive: true });
    }),
  );
}

// why: vitest resolves hooks from the call stack active during collection, so this is registered
// once at module scope; a test that times out never reaches its own cleanup.
afterEach(async () => {
  await cleanupAgents();
}, 120_000);

export async function waitForAgentDevice(env: SharedTestEnv, token: string): Promise<void> {
  let last = "no answer";
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${proxyUrl(env)}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        if (response.status < 200 || response.status > 299) {
          last = `HTTP ${response.status}: ${text}`;
          return false;
        }
        return (JSON.parse(text) as { ok?: unknown }).ok === true;
      } catch {
        return false;
      }
    },
    {
      timeout: 60_000,
      interval: 500,
      label: () => `the agent-device daemon answers /health (last reply: ${last})`,
    },
  );
}
