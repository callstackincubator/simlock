import { rm } from "node:fs/promises";

// why: Windows keeps a deleted file's folder busy until the last handle on it is released, which can
// trail a stopped daemon by seconds where Defender scans the temp folder (4.6 s seen on a PC under a
// full run), so the removal retries `EBUSY` and `EPERM` for about 10 s (Node waits longer after each try).
export function removeDirectory(path: string): Promise<void> {
  return rm(path, { force: true, maxRetries: 20, recursive: true, retryDelay: 50 });
}
