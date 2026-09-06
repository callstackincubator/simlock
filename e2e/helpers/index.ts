// Public surface for flow test files. Kept to exactly what a flow currently imports
// through this barrel -- add an export here (from its owning helper module) the
// moment a flow needs it, rather than pre-declaring the full internal surface, so an
// unused re-export is always a real signal.
export { withDaemon } from "./env.js";
// A flow that factors its own setup out of a test body needs to name what `withDaemon` hands
// back; every other flow keeps it inferred.
export type { TestEnv } from "./env.js";
export { waitFor } from "./wait.js";
export { waitForDeviceState, waitForLeaseCount } from "./status.js";
export type { CliResult } from "./cli.js";
