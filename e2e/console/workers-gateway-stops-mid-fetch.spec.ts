import type { Locator, Page, Route } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import { answerMemory, answerWithoutLoad } from "./workers-answers.js";
import { disposeFleet, expect, type RunningDaemon, signIn, startFleet, test } from "./fixtures.js";

/**
 * why: reproduces #642. The workers page's response helpers (`answerWithoutLoad`, `answerMemory`)
 * answer the page's re-reads of `/v1/workers` by fetching them from the gateway through
 * `route.fetch()`, and the page re-reads every second. A re-read intercepted but not yet fetched
 * when the test's `finally` disposes the fleet gets a refused connect — a listener destroyed
 * mid-request reads the same way as a socket hang up — and Playwright attributes the handler's
 * rejection to the test, so the spec dies on the helper's `route.fetch()` line although every
 * assertion it made had passed. The lane races that window by accident; this holds it open: the
 * next re-read is parked inside the handler before it fetches, the gateway's listener is confirmed
 * gone, and only then is the parked fetch let go. The park is the injection; every other line is
 * the lane's own.
 */

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function openConsole(page: Page, daemon: RunningDaemon): Promise<void> {
  await page.goto(daemon.url);
  await signIn(page, daemon.tokens.operator);
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
}

function workerRows(page: Page): Locator {
  return page
    .getByRole("table")
    .getByRole("row")
    .filter({ has: page.getByRole("cell") });
}

async function askForWorkerList(page: Page, daemon: RunningDaemon): Promise<number> {
  return page.evaluate(
    (bearer) =>
      fetch("/v1/workers", { headers: { authorization: bearer } }).then(
        (response) => response.status,
        () => 0,
      ),
    `Bearer ${daemon.tokens.operator}`,
  );
}

async function listenerIsGone(daemon: RunningDaemon): Promise<boolean> {
  try {
    return (await fetch(new URL("/v1/healthz", daemon.url))).status >= 400;
  } catch {
    return true;
  }
}

test.describe("the workers page response helper against a gateway whose listener stops", () => {
  test("the re-read whose gateway listener stops between its interception and the helper's fetch is dropped by the helper instead of escaping it", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "worker-a" },
      { driverScript: { ios: IOS }, label: "worker-b" },
    ]);
    let parkNext = false;
    let parkedSeen = false;
    let parkedArrived = { resolve: () => {} };
    let releaseParked = { resolve: () => {} };
    const arrived = new Promise<void>((resolve) => {
      parkedArrived = { resolve };
    });
    const released = new Promise<void>((resolve) => {
      releaseParked = { resolve };
    });
    await answerWithoutLoad(page);
    // why: Playwright runs the latest-registered route first, so this one parks the next re-read
    // before the lane's real helper above sees it, then hands it on with `fallback()`: the helper's
    // `route.fetch()` is the only line that meets the dead listener, as in the lane.
    await page.route(
      (url) => url.pathname === "/v1/workers",
      async (route: Route) => {
        if (parkNext && !parkedSeen) {
          parkedSeen = true;
          parkNext = false;
          parkedArrived.resolve();
          await released;
        }
        await route.fallback();
      },
    );

    try {
      await openConsole(page, fleet.gateway);
      await expect(workerRows(page)).toHaveCount(2);

      // why: the same helper answers through this gateway while it is up, so a refusal below is the
      // listener being gone and not a route that never worked (testing rule 2).
      expect(await askForWorkerList(page, fleet.gateway)).toBe(200);

      parkNext = true;
      const asked = askForWorkerList(page, fleet.gateway);
      await arrived;
      await disposeFleet(fleet);
      await waitFor(() => listenerIsGone(fleet.gateway), {
        interval: 50,
        label: "the gateway's HTTP listener stopped",
        timeout: 10_000,
      });
      releaseParked.resolve();

      // why: once the helper drops the re-read the page's own promise settles (0 when aborted);
      // a rejection escaping the helper fails the test at its `route.fetch()` line instead.
      await asked;
      await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
    } finally {
      await disposeFleet(fleet).catch(() => undefined);
    }
  });
});

type Handler = (route: Route) => Promise<void>;

function captureHandler(answer: (page: Page) => Promise<void>): Promise<Handler> {
  return new Promise<Handler>((resolve) => {
    const page = { route: async (_match: unknown, handler: Handler) => resolve(handler) };
    void answer(page as unknown as Page);
  });
}

test.describe("what the workers page response helper drops and what it lets through", () => {
  test("a fetch that fails for a reason other than the connection going away still rejects out of the helper", async () => {
    const handler = await captureHandler(answerWithoutLoad);
    let aborted = false;
    const route = {
      abort: async () => {
        aborted = true;
      },
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND gateway.invalid");
      },
    } as unknown as Route;

    await expect(handler(route)).rejects.toThrow("ENOTFOUND");
    expect(aborted).toBe(false);
  });

  const helpers = [
    ["answerWithoutLoad", answerWithoutLoad],
    ["answerMemory", (page: Page) => answerMemory(page, () => ({ usedPercent: 50 }))],
  ] as const;
  const goneAway = [
    ["refused at connect", "connect ECONNREFUSED 127.0.0.1:1"],
    ["destroyed mid-request (socket hang up)", "socket hang up"],
    ["reset by the peer", "read ECONNRESET"],
  ] as const;

  for (const [helperName, helper] of helpers) {
    for (const [how, message] of goneAway) {
      test(`${helperName}: a fetch ${how} is aborted and resolves quietly`, async () => {
        const handler = await captureHandler(helper);
        let aborted = false;
        const route = {
          abort: async () => {
            aborted = true;
          },
          fetch: async () => {
            throw new Error(message);
          },
        } as unknown as Route;

        await handler(route);
        expect(aborted).toBe(true);
      });
    }
  }
});
