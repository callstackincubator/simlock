import { tmpdir } from "node:os";

import type { DispatcherOptions } from "./dispatcher.js";

/** why: lease files for a test that runs exec but not their routes: every command runs in the temp folder, and no file exists. */
export const testLeaseFiles: NonNullable<DispatcherOptions["leaseFiles"]> = {
  folderOf: () => Promise.resolve(tmpdir()),
  openFile: () => Promise.reject(new Error("no lease file in this test")),
};
