import type { Filesystem } from "../ports/index.js";

export async function readLogFile(filesystem: Filesystem, logPath: string): Promise<string> {
  const rotatedPath = `${logPath}.1`;
  const segments: string[] = [];
  if (await filesystem.exists(rotatedPath)) {
    segments.push(await filesystem.readFile(rotatedPath));
  }
  segments.push(await filesystem.readFile(logPath));
  return segments.join("");
}
