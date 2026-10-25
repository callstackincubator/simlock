// Public surface for flow test files. Kept to exactly what a flow currently imports
// through this barrel -- add an export here (from its owning helper module) the
// moment a flow needs it, rather than pre-declaring the full internal surface, so an
// unused re-export is always a real signal.
export { withDaemon, withSharedDaemon } from "./env.js";
export {
  assertPinnedAgentDevice,
  cleanupAgents,
  makeAgent,
  makeProfileAgent,
  newAgentToken,
  waitForAgentDevice,
} from "./agent-device.js";
export type { Agent, AgentDeviceResult } from "./agent-device.js";
export { freeLoopbackPort } from "./port.js";
export { deviceStreamUrl } from "./device-stream.js";
export { withHttpDaemon } from "./http-daemon.js";
// A flow that factors its own setup out of a test body needs to name what `withDaemon` hands
// back; every other flow keeps it inferred.
export type { SharedTestEnv, TestEnv } from "./env.js";
export { DEVICE_READY_MS, waitFor } from "./wait.js";
export { events } from "./events.js";
export type { RecordedEvent } from "./events.js";
export { waitForDeviceState, waitForLeaseCount } from "./status.js";
export { SCREEN_TAGS, readScreenFrames } from "./screen-frames.js";
export { REPO_ROOT } from "./repo-root.js";
export type { CliResult } from "./cli.js";
export {
  ANDROID,
  FIRST_SNAPSHOT,
  IOS,
  failureText,
  hasIosRuntime,
  listDevices,
  listLeases,
  listRequests,
  ok,
  progress,
  setLimits,
  succeeds,
  waitForFree,
  warmUp,
} from "./agent-device-targets.js";
export type { RequestRow, Target } from "./agent-device-targets.js";
