import type { DriverRejection } from "./driver.js";

export class BackendUnavailableError extends Error {
  constructor(
    message: string,
    readonly rejection?: DriverRejection,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}
