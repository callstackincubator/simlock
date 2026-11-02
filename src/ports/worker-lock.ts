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

export interface NodeWorkerLockOptions {
  readonly filesystem: Filesystem;
  readonly path: string;
  readonly processSupervisor: ProcessSupervisor;
}

export class NodeWorkerLock implements WorkerLock {
  constructor(_options: NodeWorkerLockOptions) {}

  async take(_owner: WorkerLockOwner): Promise<WorkerLockHandle> {
    return { release: async () => undefined };
  }
}
