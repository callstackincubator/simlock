import type { Page, Route } from "@playwright/test";

interface WorkerPayload {
  load?:
    | {
        memory?: { availableBytes?: number; pressure?: string; totalBytes?: number } | undefined;
      }
    | undefined;
}

// why: the page re-reads the list every second, so a re-read can be intercepted just as the test's
// `finally` stops the gateway; the refused connect it gets is the fleet going away, not a failure of
// the test, and Playwright would otherwise charge the rejection to it. Only connect-level errors are
// dropped: any other error is a real fault and must still kill the test.
const CONNECT_ERROR = /ECONNREFUSED|ECONNRESET|socket hang up/i;

async function fetchOrDrop(route: Route): Promise<Awaited<ReturnType<Route["fetch"]>> | undefined> {
  try {
    return await route.fetch();
  } catch (error) {
    if (!(error instanceof Error) || !CONNECT_ERROR.test(error.message)) throw error;
    await route.abort().catch(() => undefined);
    return undefined;
  }
}

// why: the two fields a colour case has to state; everything else in the reading stays the
// daemon's.
export interface MemoryClaim {
  readonly pressure?: string;
  readonly usedPercent: number;
}

/**
 * why: only macOS reports a memory pressure, and how full a CI machine's memory happens to be is
 * nobody's to predict — so the colour test states the memory reading it wants and this writes just
 * those fields into the daemon's own answer, leaving every other field, its headers and its `Date`
 * real. The route is asked again per request, so the reading stays as fresh as the daemon's own.
 */
export async function answerMemory(page: Page, claim: () => MemoryClaim): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/workers",
    async (route: Route) => {
      const response = await fetchOrDrop(route);
      if (response === undefined) return;
      const listed = (await response.json()) as { workers: WorkerPayload[] };
      for (const worker of listed.workers) {
        const memory = worker.load?.memory;
        const total = memory?.totalBytes;
        if (memory === undefined || typeof total !== "number" || total <= 0) continue;
        const wanted = claim();
        memory.availableBytes = Math.round((total * (100 - wanted.usedPercent)) / 100);
        if (wanted.pressure === undefined) delete memory.pressure;
        else memory.pressure = wanted.pressure;
      }
      await route.fulfill({ json: listed, response });
    },
  );
}

/**
 * why: a machine's own disk or CPU may already be over a threshold, which would turn every square
 * the page draws and hide the state a test is about (a drain, a lost link). A test about squares
 * answers the page's read of the worker list without the load reading, so only the states are left.
 */
export async function answerWithoutLoad(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/v1/workers",
    async (route: Route) => {
      const response = await fetchOrDrop(route);
      if (response === undefined) return;
      const listed = (await response.json()) as { workers: WorkerPayload[] };
      for (const worker of listed.workers) delete worker.load;
      await route.fulfill({ json: listed, response });
    },
  );
}
