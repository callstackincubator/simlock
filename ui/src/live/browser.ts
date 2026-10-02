import type { Clock, Visibility } from "./connection";

/** The browser's own clock and timers: the one place the live layer reads them. */
export const browserClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number | undefined),
};

/** The page's visibility, from `document.visibilityState`. */
export const documentVisibility: Visibility = {
  hidden: () => document.visibilityState === "hidden",
  subscribe(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};
