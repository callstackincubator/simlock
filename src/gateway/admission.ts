import type { ProcessRunner } from "../ports/index.js";

/** why: ADR 0074 §1: the gateway operator's admission command and how long it may take. */
export interface AdmissionOptions {
  readonly command: readonly string[];
  readonly runner: ProcessRunner;
  readonly timeoutMs: number;
}
