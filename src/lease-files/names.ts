import { LEASE_FILE_NAME_PATTERN } from "../contract/index.js";
import { LeaseFilesError } from "./errors.js";

export function isFileName(name: string): boolean {
  return LEASE_FILE_NAME_PATTERN.test(name);
}

export function requireFileName(name: string): void {
  if (!isFileName(name)) {
    throw new LeaseFilesError(
      "BAD_REQUEST",
      `File ${name} must be 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit`,
      {},
    );
  }
}
