const DAY_MS = 24 * 60 * 60_000;

export function agentDeviceLeaseMaxTtlMs(leaseMaxTtlMs: number): number {
  return Math.max(DAY_MS, 2 * leaseMaxTtlMs);
}

export const AGENT_DEVICE_POLICY = {
  version: 1,
  commands: { deny: ["boot", "shutdown"] },
  capabilities: { deny: ["device-shutdown"] },
};

export const NO_ANDROID_DEVICE_SERIAL = "simlock-no-android-device";

export function agentDeviceDaemonEnvironment(paths: {
  readonly stateDir: string;
  readonly policyPath: string;
  readonly leaseMaxTtlMs: number;
}): Readonly<Record<string, string>> {
  return {
    AGENT_DEVICE_STATE_DIR: paths.stateDir,
    AGENT_DEVICE_CLAIMS_DIR: `${paths.stateDir}/device-claims`,
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_DAEMON_POLICY: paths.policyPath,
    AGENT_DEVICE_LEASE_MAX_TTL_MS: String(agentDeviceLeaseMaxTtlMs(paths.leaseMaxTtlMs)),
  };
}
