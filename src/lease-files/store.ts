import { join } from "node:path";

import { LeaseFilesError } from "./errors.js";
import { guardedBody } from "./guarded-body.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { isFileName } from "./names.js";
import type { LeaseFileView, LeaseFilesDeps, LeaseFilesGrant } from "./types.js";

function folderKey(id: string, grantedAt: number): string {
  return `${Buffer.from(id, "utf8").toString("hex")}-${String(grantedAt)}`;
}

interface RunningUpload {
  received: number;
  readonly abort: AbortController;
}

interface GrantState {
  ended: boolean;
  readonly uploads: Set<RunningUpload>;
  // why: every folder, upload and rename of a grant, so the lease end waits for what already started before it removes the folder.
  readonly inFlight: Set<Promise<unknown>>;
  // why: file names compare ignoring case, so a name's writer slot is its lowercase spelling.
  readonly writers: Set<string>;
}

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function tooLarge(name: string): LeaseFilesError {
  return new LeaseFilesError(
    "FILE_TOO_LARGE",
    `File ${name} is over the 2 GiB limit for one file`,
    {
      name,
    },
  );
}

function sameName(names: readonly string[], name: string): string[] {
  return names.filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

// why: the exact spelling wins; else the first spelling in byte order, which `names` is sorted by.
function lookup(names: readonly string[], name: string): string | undefined {
  return names.includes(name) ? name : sameName(names, name)[0];
}

function unknownLease(grant: LeaseFilesGrant): LeaseFilesError {
  return new LeaseFilesError("UNKNOWN_LEASE", `Unknown lease: ${grant.id}`, { leaseId: grant.id });
}

function unknownFile(name: string): LeaseFilesError {
  return new LeaseFilesError("UNKNOWN_FILE", `No file ${name} in this lease`, { name });
}

function leaseFull(grant: LeaseFilesGrant, usedBytes: number): LeaseFilesError {
  return new LeaseFilesError(
    "LEASE_FILES_FULL",
    `Lease ${grant.id} holds ${String(usedBytes)} bytes of files; this upload would pass the 4 GiB limit`,
    { leaseId: grant.id, usedBytes },
  );
}

/** why: every lease folder of a worker, behind the one set of rules the HTTP handler and exec share. */
export class LeaseFolders {
  readonly #deps: LeaseFilesDeps;
  readonly #limits;
  readonly #states = new Map<string, GrantState>();

  constructor(deps: LeaseFilesDeps) {
    this.#deps = deps;
    this.#limits = deps.limits ?? DEFAULT_LIMITS;
  }

  findGrant(leaseId: string): LeaseFilesGrant | undefined {
    return this.#deps.findGrant(leaseId);
  }

  async folderOf(grant: LeaseFilesGrant): Promise<string> {
    const folder = this.#pathOf(grant);
    await this.#track(this.#stateOf(grant), grant, () =>
      this.#deps.filesystem.mkdirp(folder, { mode: 0o700 }),
    );
    return folder;
  }

  /** why: the lease ended: nothing more is written, a running upload answers `UNKNOWN_LEASE`, and what was already running settles before the folder goes. */
  async end(grant: LeaseFilesGrant): Promise<void> {
    const state = this.#stateOf(grant);
    state.ended = true;
    for (const upload of state.uploads) upload.abort.abort(unknownLease(grant));
    while (state.inFlight.size > 0) await Promise.allSettled(state.inFlight);
    try {
      await this.#deps.filesystem.rm(this.#pathOf(grant));
    } catch (error: unknown) {
      this.#deps.logger.warn("A lease's file folder could not be removed; startup removes it", {
        error: error instanceof Error ? error.message : String(error),
        leaseId: grant.id,
      });
    }
  }

  /** why: startup removes the folder of every lease no longer live and the upload files a restart left in the rest. */
  async sweep(live: readonly { readonly id: string; readonly grantedAt: number }[]): Promise<void> {
    const { filesystem, logger } = this.#deps;
    const root = join(this.#deps.dataDirectory, "lease-files");
    const kept = new Set(live.map((grant) => folderKey(grant.id, grant.grantedAt)));
    const entries = await filesystem.readdir(root).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      try {
        const folder = join(root, entry);
        if (!kept.has(entry)) {
          await filesystem.rm(folder);
          continue;
        }
        for (const inner of await filesystem.readdir(folder)) {
          if (inner.startsWith(".upload-")) await filesystem.rm(join(folder, inner));
        }
      } catch (error: unknown) {
        logger.warn("A lease file folder could not be swept", {
          entry,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #track<T>(state: GrantState, grant: LeaseFilesGrant, work: () => Promise<T>): Promise<T> {
    const running = (async () => {
      if (state.ended) throw unknownLease(grant);
      return work();
    })();
    state.inFlight.add(running);
    try {
      return await running;
    } finally {
      state.inFlight.delete(running);
    }
  }

  async openFile(grant: LeaseFilesGrant, name: string): Promise<LeaseFileView> {
    const stored = lookup(await this.#names(grant), name);
    if (stored === undefined) throw unknownFile(name);
    const file = await this.#deps.filesystem.openFile(join(this.#pathOf(grant), stored));
    return { name: stored, ...file };
  }

  async list(
    grant: LeaseFilesGrant,
  ): Promise<readonly { readonly name: string; readonly size: number }[]> {
    const folder = this.#pathOf(grant);
    const files = [];
    for (const name of await this.#names(grant)) {
      files.push({ name, size: await this.#sizeOf(join(folder, name)) });
    }
    return files;
  }

  async remove(grant: LeaseFilesGrant, name: string): Promise<void> {
    const spellings = sameName(await this.#names(grant), name);
    if (spellings.length === 0) throw unknownFile(name);
    for (const spelling of spellings) {
      await this.#deps.filesystem.rm(join(this.#pathOf(grant), spelling));
    }
  }

  // why: only regular files whose names pass the name rule are the lease's files; a command may have left a subfolder or `my file.png` beside them.
  async #names(grant: LeaseFilesGrant): Promise<string[]> {
    const { filesystem } = this.#deps;
    const folder = this.#pathOf(grant);
    const entries = await filesystem.readdir(folder).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const names: string[] = [];
    for (const entry of entries) {
      if (!isFileName(entry)) continue;
      const details = await filesystem.lstat(join(folder, entry)).catch(() => undefined);
      if (details?.kind === "file") names.push(entry);
    }
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  async put(
    grant: LeaseFilesGrant,
    name: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number | undefined,
  ): Promise<{ readonly name: string; readonly size: number }> {
    if (contentLength !== undefined && contentLength > this.#limits.fileBytes) {
      throw tooLarge(name);
    }
    const state = this.#stateOf(grant);
    const slot = name.toLowerCase();
    if (state.writers.has(slot)) {
      throw new LeaseFilesError("FILE_BUSY", `File ${name} is being uploaded by another request`, {
        name,
      });
    }
    state.writers.add(slot);
    try {
      return await this.#track(state, grant, () =>
        this.#receive(grant, name, state, body, contentLength),
      );
    } finally {
      state.writers.delete(slot);
    }
  }

  async #receive(
    grant: LeaseFilesGrant,
    name: string,
    state: GrantState,
    body: ReadableStream<Uint8Array>,
    contentLength: number | undefined,
  ): Promise<{ readonly name: string; readonly size: number }> {
    const { filesystem, diskPressureThreshold } = this.#deps;
    const folder = await this.folderOf(grant);
    const free = await filesystem.diskFree(folder);
    if (free < diskPressureThreshold) {
      throw new LeaseFilesError(
        "INSUFFICIENT_DISK_SPACE",
        `Not enough free disk space to store ${name}: the worker keeps ${gibibytes(diskPressureThreshold)} free, only ${gibibytes(free)} available`,
        { availableBytes: free, platform: grant.platform, requiredBytes: diskPressureThreshold },
      );
    }
    const stored = await this.#folderBytes(folder, name.toLowerCase());
    const upload: RunningUpload = { abort: new AbortController(), received: 0 };
    const others = () =>
      [...state.uploads].reduce(
        (sum, running) => (running === upload ? sum : sum + running.received),
        0,
      );
    if (stored + others() + (contentLength ?? 0) > this.#limits.leaseBytes) {
      throw leaseFull(grant, stored + others());
    }
    state.uploads.add(upload);
    const temporary = join(folder, `.upload-${this.#deps.idGenerator.generate()}`);
    try {
      const size = await filesystem.writeFileStream(
        temporary,
        guardedBody(body, {
          clock: this.#deps.clock,
          onChunk: (chunk) => {
            const beforeThis = others();
            upload.received += chunk.byteLength;
            if (upload.received > this.#limits.fileBytes) throw tooLarge(name);
            if (stored + beforeThis + upload.received > this.#limits.leaseBytes) {
              throw leaseFull(grant, stored + beforeThis);
            }
          },
          onStalled: () =>
            new LeaseFilesError(
              "UPLOAD_STALLED",
              `No bytes of ${name} arrived for ${String(this.#limits.silenceMs / 1000)} s`,
              { name },
            ),
          signal: upload.abort.signal,
          silenceMs: this.#limits.silenceMs,
        }),
        { mode: 0o600 },
      );
      for (const other of sameName(await this.#names(grant), name)) {
        if (other !== name) await filesystem.rm(join(folder, other));
      }
      if (state.ended) throw unknownLease(grant);
      await filesystem.rename(temporary, join(folder, name));
      return { name, size };
    } catch (error: unknown) {
      await filesystem.rm(temporary);
      throw error;
    } finally {
      state.uploads.delete(upload);
    }
  }

  #pathOf(grant: LeaseFilesGrant): string {
    return join(this.#deps.dataDirectory, "lease-files", folderKey(grant.id, grant.grantedAt));
  }

  #stateOf(grant: LeaseFilesGrant): GrantState {
    const key = folderKey(grant.id, grant.grantedAt);
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { ended: false, inFlight: new Set(), uploads: new Set(), writers: new Set() };
      this.#states.set(key, state);
    }
    return state;
  }

  // why: a file listed a moment ago may be gone (a command removed it), and it then counts for nothing.
  async #sizeOf(path: string): Promise<number> {
    try {
      return (await this.#deps.filesystem.stat(path)).size;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  // why: every entry counts, whoever wrote it (subfolders walked, symlinks not followed); upload temp files are the running uploads' received bytes instead.
  async #folderBytes(folder: string, replacing: string | undefined): Promise<number> {
    const { filesystem } = this.#deps;
    let total = 0;
    for (const entry of await filesystem.readdir(folder)) {
      if (entry.startsWith(".upload-")) continue;
      if (replacing !== undefined && entry.toLowerCase() === replacing) continue;
      const child = join(folder, entry);
      const details = await filesystem.lstat(child).catch(() => undefined);
      if (details?.kind === "directory") total += await this.#folderBytes(child, undefined);
      else if (details?.kind === "file") total += await this.#sizeOf(child);
    }
    return total;
  }
}
