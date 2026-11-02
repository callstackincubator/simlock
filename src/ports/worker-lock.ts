import { dirname, join } from "node:path";

import type { Filesystem } from "./filesystem.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

export interface WorkerLockOwner {
  readonly pid: number;
  readonly folder: string;
  readonly startedAt: string;
}

export interface WorkerLockHandle {
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

export class NodeWorkerLock implements WorkerLock {
  readonly #options: NodeWorkerLockOptions;

  constructor(options: NodeWorkerLockOptions) {
    this.#options = options;
  }

  async take(owner: WorkerLockOwner): Promise<WorkerLockHandle> {
    const { filesystem, path, processSupervisor } = this.#options;
    const ownerFile = join(path, OWNER_FILE);
    await filesystem.mkdirp(dirname(path), { mode: 0o700 });
    try {
      await filesystem.mkdir(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = JSON.parse(await filesystem.readFile(ownerFile)) as WorkerLockOwner;
      if (processSupervisor.isAlive(holder.pid) && holder.folder !== owner.folder) {
        throw new WorkerLockHeldError(holder);
      }
    }
    await filesystem.writeFileAtomic(ownerFile, JSON.stringify(owner));
    return { release: async () => undefined };
  }
}
