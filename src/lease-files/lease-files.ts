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

interface RunningUpload {
  received: number;
}

interface GrantState {
  readonly uploads: Set<RunningUpload>;
}

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
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

  const states = new Map<string, GrantState>();
  const stateOf = (grant: LeaseFilesGrant): GrantState => {
    const key = folderKey(grant.id, grant.grantedAt);
    let state = states.get(key);
    if (state === undefined) {
      state = { uploads: new Set() };
      states.set(key, state);
    }
    return state;
  };

  // why: a file listed a moment ago may be gone (a command removed it), and it then counts for nothing.
  const sizeOf = async (path: string): Promise<number> => {
    try {
      return (await filesystem.stat(path)).size;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  };

  // why: every entry counts, whoever wrote it (subfolders walked, symlinks not followed); upload temp files are the running uploads' received bytes instead.
  const folderBytes = async (folder: string, replacing: string | undefined): Promise<number> => {
    let total = 0;
    for (const entry of await filesystem.readdir(folder)) {
      if (entry.startsWith(".upload-")) continue;
      if (replacing !== undefined && entry.toLowerCase() === replacing) continue;
      const child = join(folder, entry);
      const details = await filesystem.lstat(child).catch(() => undefined);
      if (details?.kind === "directory") total += await folderBytes(child, undefined);
      else if (details?.kind === "file") total += await sizeOf(child);
    }
    return total;
  };

  const store: LeaseFileStore = {
    findGrant: deps.findGrant,
    openFile,
    put: async (grant, name, body, contentLength) => {
      const tooLarge = () =>
        new LeaseFilesError("FILE_TOO_LARGE", `File ${name} is over the 2 GiB limit for one file`, {
          name,
        });
      const full = (usedBytes: number) =>
        new LeaseFilesError(
          "LEASE_FILES_FULL",
          `Lease ${grant.id} holds ${String(usedBytes)} bytes of files; this upload would pass the 4 GiB limit`,
          { leaseId: grant.id, usedBytes },
        );
      if (contentLength !== undefined && contentLength > limits.fileBytes) throw tooLarge();
      const folder = await folderOf(grant);
      const free = await filesystem.diskFree(folder);
      if (free < deps.diskPressureThreshold) {
        throw new LeaseFilesError(
          "INSUFFICIENT_DISK_SPACE",
          `Not enough free disk space to store ${name}: the worker keeps ${gibibytes(deps.diskPressureThreshold)} free, only ${gibibytes(free)} available`,
          {
            availableBytes: free,
            platform: grant.platform,
            requiredBytes: deps.diskPressureThreshold,
          },
        );
      }
      const state = stateOf(grant);
      const stored = await folderBytes(folder, name.toLowerCase());
      const upload: RunningUpload = { received: 0 };
      const others = () => [...state.uploads].reduce((sum, running) => sum + running.received, 0);
      if (stored + others() + (contentLength ?? 0) > limits.leaseBytes)
        throw full(stored + others());
      state.uploads.add(upload);
      const temporary = join(folder, `.upload-${deps.idGenerator.generate()}`);
      try {
        const size = await filesystem.writeFileStream(
          temporary,
          guardedBody(body, (chunk) => {
            const beforeThis = others();
            upload.received += chunk.byteLength;
            if (upload.received > limits.fileBytes) throw tooLarge();
            if (stored + beforeThis + upload.received > limits.leaseBytes) {
              throw full(stored + beforeThis);
            }
          }),
          { mode: 0o600 },
        );
        await filesystem.rename(temporary, join(folder, name));
        return { name, size };
      } catch (error: unknown) {
        await filesystem.rm(temporary);
        throw error;
      } finally {
        state.uploads.delete(upload);
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
