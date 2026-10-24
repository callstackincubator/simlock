import type { OptionalModuleFinding } from "../../core/index.js";
import type { AgentDeviceAvailability, AgentDeviceRole } from "./agent-device-supervisor.js";

// why: ADR 0046 §1: a command never found while the module is on only by default is no fault of this Mac, so it is neither reported nor an unavailable capability.
export function isAbsentByDefault(
  availability: AgentDeviceAvailability,
  enabledByDefault: boolean,
): boolean {
  return (
    enabledByDefault && availability.state === "unavailable" && availability.reason === "not-found"
  );
}

export function agentDeviceFindings(
  availability: AgentDeviceAvailability,
  role: AgentDeviceRole = "simulators",
  enabledByDefault = false,
): readonly OptionalModuleFinding[] {
  if (availability.state !== "unavailable") return [];
  if (isAbsentByDefault(availability, enabledByDefault)) return [];
  return [
    {
      kind: "module-unavailable",
      module: "agent-device",
      message: role === "phones" ? `phone daemon: ${availability.message}` : availability.message,
      remedy: availability.remedy,
    },
  ];
}
