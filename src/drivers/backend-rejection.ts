import type { DriverRejection, OwnedRootError } from "../core/index.js";

export function rootRejection(
  error: OwnedRootError,
  passthroughTools: readonly string[],
): DriverRejection {
  return {
    event: "driver.root-rejected",
    passthroughTools,
    payload: { platform: error.platform, reason: error.reason, root: error.path },
    platform: error.platform,
    reason: error.reason,
    summary: error.message,
  };
}
