import type { Identity } from "../auth/index.js";
import { handleRequest } from "./handler.js";
import { LeaseFolders } from "./store.js";
import type { LeaseFiles, LeaseFilesDeps, LeaseFilesLease } from "./types.js";

export function createLeaseFiles(deps: LeaseFilesDeps): LeaseFiles {
  const folders = new LeaseFolders(deps);
  return {
    folderOf: (grant) => folders.folderOf(grant),
    handle: (
      request: Request,
      _identity: Identity,
      lease: LeaseFilesLease,
      name: string | undefined,
    ) => handleRequest(folders, request, lease, name),
    leaseEnd: { leaseEnded: () => Promise.resolve() },
    openFile: (grant, name) => folders.openFile(grant, name),
    sweep: () => Promise.resolve(),
  };
}
