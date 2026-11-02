import { dirname, join } from "node:path";

import type { Filesystem } from "./filesystem.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

export interface WorkerLockOwner {
  readonly pid: number;
  readonly folder: string;
  readonly startedAt: string;
}

export interface WorkerLockHandle {
  /** why: a live holder in the same folder is a daemon that may lose the socket claim; the one that wins writes itself as the owner. */
  claimed(): Promise<void>;
  release(): Promise<void>;
}

export interface WorkerLock {
  take(owner: WorkerLockOwner): Promise<WorkerLockHandle>;
}

export class WorkerLockHeldError extends Error {
  constructor(readonly holder: WorkerLockOwner) {
    super(
      `another Simlock worker runs for this user (pid ${holder.pid}, folder ${holder.folder}, since ${holder.startedAt}); stop it first: SIMLOCK_HOME=${holder.folder} simlock daemon stop`,
    );
    this.name = "WorkerLockHeldError";
  }
}

export interface NodeWorkerLockOptions {
  readonly filesystem: Filesystem;
  readonly path: string;
  readonly processSupervisor: ProcessSupervisor;
  readonly uid?: number | undefined;
}

const OWNER_FILE = "owner.json";

export function defaultWorkerLockPath(
  platform: NodeJS.Platform,
  uid: number,
  tmpdir: string,
): string {
  return platform === "win32"
    ? `${tmpdir}\\simlock\\worker.lock`
    : `/tmp/simlock-${uid}/worker.lock`;
}

// why: an owner.json that is missing, not JSON or not the three fields is unreadable, and an unreadable lock is stale.
async function readOwner(
  filesystem: Filesystem,
  ownerFile: string,
): Promise<WorkerLockOwner | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await filesystem.readFile(ownerFile));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { folder, pid, startedAt } = parsed as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    typeof folder !== "string" ||
    typeof startedAt !== "string"
  ) {
    return undefined;
  }
  return { folder, pid, startedAt };
}

export class NodeWorkerLock implements WorkerLock {
  readonly #options: NodeWorkerLockOptions;

  constructor(options: NodeWorkerLockOptions) {
    this.#options = options;
  }

  // why: the lock's parent is in a folder every user can write (/tmp), so on POSIX it must be this user's and 0700, or another user could plant a lock.
  async #prepareParent(): Promise<void> {
    const parent = dirname(this.#options.path);
    const reason = await this.#parentProblem(parent);
    if (reason !== undefined) {
      throw new Error(`${parent} cannot be used as the worker lock folder: ${reason}`);
    }
  }

  async #parentProblem(parent: string): Promise<string | undefined> {
    const { filesystem, uid } = this.#options;
    try {
      await filesystem.mkdirp(parent, { mode: 0o700 });
      if (uid === undefined) return undefined;
      const details = await filesystem.lstat(parent);
      if (details.kind !== "directory") return `it is a ${details.kind}, not a directory`;
      if (details.uid !== uid) return "owned by another user";
      if (details.mode !== 0o700) await filesystem.chmod(parent, 0o700);
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async take(owner: WorkerLockOwner): Promise<WorkerLockHandle> {
    const { filesystem, path, processSupervisor } = this.#options;
    const ownerFile = join(path, OWNER_FILE);
    await this.#prepareParent();
    try {
      await filesystem.mkdir(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readOwner(filesystem, ownerFile);
      if (holder !== undefined && processSupervisor.isAlive(holder.pid)) {
        // why: the same folder is a second daemon on one home, which the socket claim answers as today; it holds nothing to release.
        if (holder.folder === owner.folder) return this.#handle(owner);
        throw new WorkerLockHeldError(holder);
      }
    }
    await filesystem.writeFileAtomic(ownerFile, JSON.stringify(owner));
    return this.#handle(owner);
  }

  #handle(owner: WorkerLockOwner): WorkerLockHandle {
    const { filesystem, path } = this.#options;
    return {
      claimed: () => filesystem.writeFileAtomic(join(path, OWNER_FILE), JSON.stringify(owner)),
      release: async () => undefined,
    };
  }
}
