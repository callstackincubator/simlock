import type { LeaseFilesLimits } from "./types.js";

/** why: a gateway refuses a larger `Content-Length` itself, because the relay does not carry that header to the worker. */
export const MAX_FILE_BYTES = 2 * 1024 ** 3;

export const DEFAULT_LIMITS: LeaseFilesLimits = {
  fileBytes: MAX_FILE_BYTES,
  leaseBytes: 4 * 1024 ** 3,
  silenceMs: 330_000,
};
