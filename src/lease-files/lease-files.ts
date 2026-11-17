import type { Identity } from "../auth/index.js";
import { handleRequest } from "./handler.js";
import { relayTarget } from "./relay-target.js";
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
    leaseEnd: {
      leaseEnded: (ended) =>
        folders.end({ grantedAt: ended.grantedAt, id: ended.leaseId, platform: ended.platform }),
    },
    openFile: (grant, name) => folders.openFile(grant, name),
    relayTarget: relayTarget(folders),
    sweep: (live) => folders.sweep(live),
  };
}
