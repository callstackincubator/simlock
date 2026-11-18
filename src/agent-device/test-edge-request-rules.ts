import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import { type Rig, iosDriver, androidDriver } from "./test-support.js";

export const bothDrivers = (clock: FakeClock): FakeDriver[] => [
  iosDriver(clock),
  androidDriver(clock),
];

export function commandsReceived(rig: Rig) {
  return rig.fake.rpcRequests("agent_device.command");
}

export function flagsOf(params: Record<string, unknown>): Record<string, unknown> {
  return (params["flags"] ?? {}) as Record<string, unknown>;
}
