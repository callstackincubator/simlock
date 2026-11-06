import type { LeaseFilesLimits } from "./types.js";

export const DEFAULT_LIMITS: LeaseFilesLimits = {
  fileBytes: 2 * 1024 ** 3,
  leaseBytes: 4 * 1024 ** 3,
  silenceMs: 330_000,
};
