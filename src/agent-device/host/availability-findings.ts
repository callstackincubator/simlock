import type { OptionalModuleFinding } from "../../core/index.js";
import type { AgentDeviceAvailability, AgentDeviceRole } from "./agent-device-supervisor.js";

export function agentDeviceFindings(
  availability: AgentDeviceAvailability,
  role: AgentDeviceRole = "simulators",
): readonly OptionalModuleFinding[] {
  if (availability.state !== "unavailable") return [];
  return [
    {
      kind: "module-unavailable",
      module: "agent-device",
      message: role === "phones" ? `phone daemon: ${availability.message}` : availability.message,
      remedy: availability.remedy,
    },
  ];
}
