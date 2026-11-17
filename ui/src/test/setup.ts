import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// why: happy-dom lays nothing out, so every element is 0px wide and a table would drop each column
// it may drop. An element here is as wide as the window; how a narrow table drops its columns is the
// browser lane's (`e2e/console/breakpoints.spec.ts`).
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => window.innerWidth,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
