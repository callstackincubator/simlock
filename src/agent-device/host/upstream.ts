import type { AgentDeviceAvailability } from "./agent-device-supervisor.js";

export type AgentDeviceUpstreamState =
  | {
      readonly state: "running";
      readonly baseUrl: string;
      readonly token: string;
      readonly generation: number;
      readonly leaseMaxTtlMs: number;
    }
  | { readonly state: "unavailable"; readonly reason: string };

export interface AgentDeviceUpstream {
  current(): AgentDeviceUpstreamState;
  fetch(request: Request): Promise<Response>;
}

export class SupervisorAgentDeviceUpstream implements AgentDeviceUpstream {
  constructor(readonly supervisor: { availability(): AgentDeviceAvailability }) {}

  current(): AgentDeviceUpstreamState {
    const availability = this.supervisor.availability();
    switch (availability.state) {
      case "running":
        return {
          baseUrl: availability.baseUrl,
          generation: availability.generation,
          leaseMaxTtlMs: availability.leaseMaxTtlMs,
          state: "running",
          token: availability.token,
        };
      case "unavailable":
        return { reason: availability.message, state: "unavailable" };
      default:
        return { reason: availability.state === "off" ? "off" : "starting", state: "unavailable" };
    }
  }

  async fetch(request: Request): Promise<Response> {
    return globalThis.fetch(request);
  }
}
