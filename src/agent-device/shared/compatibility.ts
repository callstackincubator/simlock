// why: 0.21.28 is the first agent-device release with every change the edge relies on (tenant authenticate, caller-chosen lease ids, allocate by spec, the iOS device set, session end with the lease, release after close, the lease on uploads).
export const MIN_AGENT_DEVICE_VERSION = "0.21.28";
export const AGENT_DEVICE_RPC_PROTOCOL_VERSION = 2;
export const MIN_NODE_VERSION = "22.12.0";

interface ParsedVersion {
  readonly numbers: readonly [number, number, number];
  readonly prerelease: boolean;
}

function parse(version: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?/.exec(version.trim());
  if (match === null) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

// why: a prerelease of the minimum sorts below it, as in semver: agent-device nightlies of 0.21.28 predate most of what 0.21.28 ships.
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const found = parse(version);
  const needed = parse(minimum);
  if (found === undefined || needed === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (found.numbers[index] ?? 0) - (needed.numbers[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return !found.prerelease;
}
