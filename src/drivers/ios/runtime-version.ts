// why: the iOS major and minor a simulator's runtime id names; the slim pass and the device input both decide by it.
export function iosRuntimeVersionFromId(runtimeId: string): readonly [number, number] | undefined {
  const match = /iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(runtimeId);
  if (match === null) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = match[2] === undefined ? 0 : Number.parseInt(match[2], 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return undefined;
  }
  return [major, minor];
}
