import { describe, expect, it } from "vitest";

import type { AgentDeviceAvailability } from "./agent-device-supervisor.js";
import { agentDeviceFindings } from "./availability-findings.js";

describe("agentDeviceFindings", () => {
  const reasons = [
    "not-found",
    "not-agent-device",
    "wrong-version",
    "state-dir",
    "start-failed",
  ] as const;

  it.each(reasons)(
    "returns one finding with module agent-device and the availability's message and remedy for the %s reason",
    (reason) => {
      const availability: AgentDeviceAvailability = {
        message: `message for ${reason}`,
        reason,
        remedy: `remedy for ${reason}`,
        state: "unavailable",
      };

      expect(agentDeviceFindings(availability)).toStrictEqual([
        {
          kind: "module-unavailable",
          module: "agent-device",
          message: `message for ${reason}`,
          remedy: `remedy for ${reason}`,
        },
      ]);
    },
  );

  it.each([
    { state: "off" },
    { state: "starting" },
    {
      baseUrl: "http://127.0.0.1:4310",
      generation: 1,
      leaseMaxTtlMs: 1000,
      platforms: ["ios"],
      state: "running",
      token: "t",
      version: "0.21.28",
    },
  ] as const satisfies readonly AgentDeviceAvailability[])(
    "returns no finding for the $state state",
    (availability) => {
      expect(agentDeviceFindings(availability)).toStrictEqual([]);
    },
  );
});
