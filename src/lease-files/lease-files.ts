import { join } from "node:path";

import type { Identity } from "../auth/index.js";
import { LeaseFilesError } from "./errors.js";
import { guardedBody } from "./guarded-body.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { handleRequest } from "./handler.js";
import type {
  LeaseFileView,
  LeaseFiles,
  LeaseFilesDeps,
  LeaseFilesGrant,
  LeaseFilesLease,
} from "./types.js";

export function folderKey(id: string, grantedAt: number): string {
  return `${Buffer.from(id, "utf8").toString("hex")}-${String(grantedAt)}`;
}

/** why: the store's part the HTTP handler calls; `LeaseFiles` is the surface other modules get. */
export interface LeaseFileStore {
  put(
    grant: LeaseFilesGrant,
    name: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number | undefined,
  ): Promise<{ readonly name: string; readonly size: number }>;
  openFile(grant: LeaseFilesGrant, name: string): Promise<LeaseFileView>;
  findGrant(leaseId: string): LeaseFilesGrant | undefined;
}

export function createLeaseFiles(deps: LeaseFilesDeps): LeaseFiles {
  const { filesystem } = deps;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const rootOf = () => join(deps.dataDirectory, "lease-files");
  const pathOf = (grant: LeaseFilesGrant) => join(rootOf(), folderKey(grant.id, grant.grantedAt));

  const folderOf = async (grant: LeaseFilesGrant): Promise<string> => {
    const folder = pathOf(grant);
    await filesystem.mkdirp(folder, { mode: 0o700 });
    return folder;
  };

  const openFile = async (grant: LeaseFilesGrant, name: string): Promise<LeaseFileView> => {
    const file = await filesystem.openFile(join(pathOf(grant), name));
    return { name, ...file };
  };

  const store: LeaseFileStore = {
    findGrant: deps.findGrant,
    openFile,
    put: async (grant, name, body, contentLength) => {
      const tooLarge = () =>
        new LeaseFilesError("FILE_TOO_LARGE", `File ${name} is over the 2 GiB limit for one file`, {
          name,
        });
      if (contentLength !== undefined && contentLength > limits.fileBytes) throw tooLarge();
      const folder = await folderOf(grant);
      const temporary = join(folder, `.upload-${deps.idGenerator.generate()}`);
      let received = 0;
      try {
        const size = await filesystem.writeFileStream(
          temporary,
          guardedBody(body, (chunk) => {
            received += chunk.byteLength;
            if (received > limits.fileBytes) throw tooLarge();
          }),
          { mode: 0o600 },
        );
        await filesystem.rename(temporary, join(folder, name));
        return { name, size };
      } catch (error: unknown) {
        await filesystem.rm(temporary);
        throw error;
      }
    },
  };

  return {
    folderOf,
    handle: (
      request: Request,
      _identity: Identity,
      lease: LeaseFilesLease,
      name: string | undefined,
    ) => handleRequest(store, request, lease, name),
    leaseEnd: { leaseEnded: () => Promise.resolve() },
    openFile,
    sweep: () => Promise.resolve(),
  };
}
