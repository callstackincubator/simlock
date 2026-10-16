import { describe, expect, it, vi } from "vitest";

import { AgentDeviceHost } from "./host.js";
import type { AgentDeviceUpstream } from "./upstream.js";

vi.mock("@agent-device/proxy", () => {
  throw new Error("module not found");
});

const running = {
  baseUrl: "http://127.0.0.1:47001",
  generation: 1,
  leaseMaxTtlMs: 600_000,
  state: "running",
  token: "daemon-token",
} as const;

describe("the agent-device host", () => {
  it("answers unavailable with `could not load @agent-device/proxy` when the proxy package fails to load, before any allocate is served", async () => {
    const upstream = {
      current: () => running,
      fetch: async () => new Response(),
    } as unknown as AgentDeviceUpstream;
    const host = new AgentDeviceHost(upstream, ["ios"]);

    expect(await host.status()).toEqual({
      reason: expect.stringMatching(/^could not load @agent-device\/proxy: ./),
      state: "unavailable",
    });
  });

  it("passes the upstream's own reason through while the daemon is unavailable", async () => {
    const upstream = {
      current: () => ({ reason: "agent-device is stopped", state: "unavailable" }),
      fetch: async () => new Response(),
    } as unknown as AgentDeviceUpstream;

    expect(await new AgentDeviceHost(upstream, ["ios"]).status()).toEqual({
      reason: "agent-device is stopped",
      state: "unavailable",
    });
  });
});
