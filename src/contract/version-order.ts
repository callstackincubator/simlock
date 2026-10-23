function split(version: string): { core: number[]; prerelease: string[] } {
  const [core = "", prerelease] = version.split("-", 2) as [string, string | undefined];
  return { core: core.split(".").map(Number), prerelease: prerelease?.split(".") ?? [] };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNewerVersion(candidate: string, running: string): boolean {
  const left = split(candidate);
  const right = split(running);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === 0 && right.prerelease.length > 0;
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifiers(left.prerelease[index] ?? "", right.prerelease[index] ?? "");
    if (order !== 0) return order > 0;
  }
  return left.prerelease.length > right.prerelease.length;
}
