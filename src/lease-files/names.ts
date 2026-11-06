import { LeaseFilesError } from "./errors.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isFileName(name: string): boolean {
  return NAME_PATTERN.test(name);
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
