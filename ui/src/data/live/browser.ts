import type { Clock, Visibility } from "./connection";

export const browserClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number | undefined),
};

export const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === "hidden",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};
