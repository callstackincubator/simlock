import { rm } from "node:fs/promises";

// why: Windows keeps a deleted file's folder busy until the last handle on it is released, which can
// trail a stopped daemon by a few ms, so the removal retries `EBUSY` and `EPERM` for about 3 s (Node waits longer after each try).
export function removeDirectory(path: string): Promise<void> {
  return rm(path, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
}
