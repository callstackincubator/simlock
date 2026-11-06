import type { LeaseFiles, LeaseFilesDeps } from "./types.js";

export function createLeaseFiles(_deps: LeaseFilesDeps): LeaseFiles {
  return {
    folderOf: () => Promise.resolve(""),
    handle: () => Promise.resolve(new Response(null, { status: 501 })),
    leaseEnd: { leaseEnded: () => Promise.resolve() },
    openFile: () => Promise.reject(new Error("not built")),
    sweep: () => Promise.resolve(),
  };
}
