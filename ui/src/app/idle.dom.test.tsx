import { screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { renderConsole } from "../test/console";
import { device, lease, worker } from "../test/fixtures";

const WORKERS = 50;
const DEVICES_PER_WORKER = 10;
const LEASES = 300;
const WINDOW_MS = 60_000;
const QUIET_MS = 2_000;
const IDLE_CEILING = 40;

const PAGES = [
  "Overview",
  "Inbox",
  "Fleet",
  "Leases",
  "Queue",
  "Baselines",
  "Activity",
  "Usage",
] as const;

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

// why: fifty workers with ten devices each and three hundred leases, written out by hand.
function fleet() {
  return Array.from({ length: WORKERS }, (_, at) =>
    worker({
      devices: Array.from({ length: DEVICES_PER_WORKER }, (_, index) =>
        device({ id: `dev_${pad(at * DEVICES_PER_WORKER + index + 1)}` }),
      ),
      id: `wrk_${pad(at + 1)}`,
      label: `worker-${pad(at + 1)}`,
    }),
  );
}

function held() {
  return Array.from({ length: LEASES }, (_, index) =>
    lease({
      deviceId: `dev_${pad(index + 1)}`,
      id: `lse_${pad(index + 1)}`,
      ownerId: "tok_load",
      requesterId: "tok_load",
    }),
  );
}

describe("an idle console on a big fleet", () => {
  // why: Testing Library waits on the real clock unless it sees Jest's name for the fake one; this
  // is vitest's clock under that name, set for these tests alone.
  beforeAll(() => {
    Object.assign(globalThis, { jest: { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) } });
  });
  afterAll(() => {
    Reflect.deleteProperty(globalThis, "jest");
  });

  it.each(PAGES)(
    "stays quiet on %s: in the 60 s after its first reads, at most 40 requests to /v1 other than the event stream",
    async (label) => {
      const workers = fleet();
      const leases = held();
      const { calls, user } = renderConsole({
        fakeTimers: true,
        routes: {
          "/v1/leases": () => ({ body: { leases } }),
          "/v1/workers": () => ({ body: { workers } }),
        },
      });
      const nav = await screen.findByRole("navigation", { name: "Console" });
      if (label !== "Overview") {
        await user.click(within(nav).getByRole("link", { name: new RegExp(`^${label}`) }));
      }
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeVisible();

      await vi.advanceTimersByTimeAsync(QUIET_MS);
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(WINDOW_MS);

      // why: a hidden page reads nothing, so it would pass without having been watched.
      expect(document.visibilityState).toBe("visible");
      expect(
        calls.length - before,
        `requests to /v1 on ${label} in ${WINDOW_MS / 1000} s`,
      ).toBeLessThanOrEqual(IDLE_CEILING);
      expect(calls.length).toBeGreaterThan(0);
    },
  );
});
