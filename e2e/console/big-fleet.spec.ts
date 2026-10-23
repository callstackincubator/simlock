import type { Request } from "@playwright/test";
import type { z } from "zod";

import type { workerViewSchema } from "../../src/contract/index.js";
import { expect, NAV, openFromNav, signIn, test } from "./fixtures.js";
import { answer, leases, pad } from "./stub-answers.js";

type WorkerView = z.infer<typeof workerViewSchema>;

const WORKERS = 50;
const DEVICES_PER_WORKER = 10;
const LEASES = 300;
const WINDOW_MS = 60_000;
const QUIET_MS = 2_000;
const FIRST_READS_MAX_MS = 15_000;
const IDLE_CEILING = 40;

function fleet(): WorkerView[] {
  const now = Date.now();
  return Array.from({ length: WORKERS }, (_, worker) => ({
    id: `wrk_${pad(worker + 1)}`,
    label: `worker-${pad(worker + 1)}`,
    connection: "connected",
    drained: false,
    lastSeenAt: now,
    health: "running",
    devices: Array.from({ length: DEVICES_PER_WORKER }, (_, device) => ({
      id: `dev_${pad(worker * DEVICES_PER_WORKER + device + 1)}`,
      physical: false,
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
      state: "ready",
    })),
  }));
}

function isCounted(request: Request): boolean {
  const { pathname } = new URL(request.url());
  return pathname.startsWith("/v1/") && pathname !== "/v1/events/stream";
}

test.describe("big fleet", () => {
  test("an idle console on a big fleet stays quiet: for each of the seven pages, in the 60 s after its first reads, at most 40 requests to /v1 other than the event stream", async ({
    gateway,
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    const workers = fleet();
    await answer(page, "/v1/workers", () => ({ workers }));
    await answer(page, "/v1/leases", () => ({ leases: leases(LEASES) }));
    let lastSentAt = Date.now();
    const sent: string[] = [];
    page.on("request", (request) => {
      if (!isCounted(request)) return;
      lastSentAt = Date.now();
      sent.push(new URL(request.url()).pathname);
    });

    await page.goto(gateway.url);
    await signIn(page, gateway.tokens.operator);
    for (const { label } of NAV) {
      if (label !== "Overview") await openFromNav(page, label);
      await expect(page.locator("#main h1")).toHaveText(label);
      const navigated = Date.now();
      lastSentAt = navigated;
      while (Date.now() - navigated < FIRST_READS_MAX_MS && Date.now() - lastSentAt < QUIET_MS) {
        await page.waitForTimeout(250);
      }
      const before = sent.length;
      await page.waitForTimeout(WINDOW_MS);
      expect(
        sent.length - before,
        `requests to /v1 on ${label} in ${WINDOW_MS / 1000} s`,
      ).toBeLessThanOrEqual(IDLE_CEILING);
    }
  });
});
