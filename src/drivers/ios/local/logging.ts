import type { SilenceFailedFact, WindowFailedFact } from "../index.js";
import type { Logger } from "../../../ports/index.js";

export function logSilenceFailure(logger: Logger): (fact: SilenceFailedFact) => void {
  return (fact) => {
    logger.warn("Could not silence iOS simulator", {
      deviceId: fact.deviceId,
      detail: fact.detail,
    });
  };
}

export function logWindowFailure(logger: Logger): (fact: WindowFailedFact) => void {
  return (fact) => {
    logger.warn("Could not open a window for iOS simulator", {
      deviceId: fact.deviceId,
      detail: fact.detail,
    });
  };
}
