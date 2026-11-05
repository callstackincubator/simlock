import { rm } from "node:fs/promises";

/**
 * why: teardown deletes a home an emulator may still be writing into while it exits (its
 * `modem_simulator` folder gains files between rm's listing and its rmdir, so rmdir fails with
 * ENOTEMPTY). Node's rm retries that error, with a growing delay, until the writer is gone.
 */
export async function removeHome(home: string): Promise<void> {
  await rm(home, { force: true, maxRetries: 20, recursive: true, retryDelay: 250 });
}
