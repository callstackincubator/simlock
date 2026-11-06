import type { Identity } from "../auth/index.js";
import type { Platform } from "../contract/index.js";
import type { LeaseEndParticipant } from "../leasing/index.js";
import type { Clock, Filesystem, IdGenerator, Logger } from "../ports/index.js";

/** why: the live grant a lease folder belongs to; `grantedAt` keeps two grants of one lease id apart. */
export interface LeaseFilesGrant {
  readonly id: string;
  readonly grantedAt: number;
  readonly platform: Platform;
}

/** why: the lease as the HTTP app resolved it, which a gateway's own handler reads further than a worker's. */
export interface LeaseFilesLease {
  readonly id: string;
  readonly deviceId: string;
  readonly workerId?: string;
  readonly workerLeaseId?: string;
}

export interface LeaseFilesLimits {
  readonly fileBytes: number;
  readonly leaseBytes: number;
  readonly silenceMs: number;
}

export interface LeaseFilesDeps {
  readonly filesystem: Filesystem;
  readonly dataDirectory: string;
  readonly diskPressureThreshold: number;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly idGenerator: IdGenerator;
  readonly findGrant: (leaseId: string) => LeaseFilesGrant | undefined;
  /** why: for tests only; nothing in config sets it. */
  readonly limits?: LeaseFilesLimits;
}

export interface LeaseFileView {
  readonly name: string;
  readonly size: number;
  read(range?: { readonly start: number; readonly end: number }): ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface LeaseFiles {
  handle(
    request: Request,
    identity: Identity,
    lease: LeaseFilesLease,
    name: string | undefined,
  ): Promise<Response>;
  folderOf(grant: LeaseFilesGrant): Promise<string>;
  openFile(grant: LeaseFilesGrant, name: string): Promise<LeaseFileView>;
  readonly leaseEnd: LeaseEndParticipant;
  sweep(liveGrants: readonly { readonly id: string; readonly grantedAt: number }[]): Promise<void>;
}
