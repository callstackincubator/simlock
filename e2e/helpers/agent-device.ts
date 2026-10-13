import type { CliBackgroundHandle } from "./cli.js";
import type { SharedTestEnv } from "./env.js";

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

export function newAgentToken(_env: SharedTestEnv): Promise<{ secret: string; id: string }> {
  return Promise.reject(new Error("newAgentToken is not implemented"));
}

export function makeAgent(_env: SharedTestEnv, _name: string): Promise<Agent> {
  return Promise.reject(new Error("makeAgent is not implemented"));
}

export function cleanupAgents(): Promise<void> {
  return Promise.reject(new Error("cleanupAgents is not implemented"));
}

export function waitForAgentDevice(_env: SharedTestEnv, _token: string): Promise<void> {
  return Promise.reject(new Error("waitForAgentDevice is not implemented"));
}
