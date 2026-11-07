import { mkdir } from "node:fs/promises";

import { expect, mintJoinToken, settled, signIn, startDaemon, test } from "./fixtures.js";
import { renderCases, renderFixture } from "./render-fixtures.js";

test.use({ locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce" });

const cases = await renderCases();
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

for (const entry of cases) {
  for (const viewport of viewports) {
    test(`a reviewer opens the render harness and receives stable named screenshots from signed-in fixture pages: ${entry.name} ${viewport.width}x${viewport.height}`, async ({
      browser,
    }, testInfo) => {
      test.setTimeout(180_000);
      expect(
        cases.map(({ name }) => name),
        "named reference and unreferenced pages",
      ).toEqual([
        "1-overview",
        "2-fleet",
        "3-worker",
        "4-device-screen-drawer",
        "5-leases",
        "6-lease-drawer",
        "7-baselines",
        "8-activity",
        "inbox",
        "queue",
        "usage",
        "not-found",
      ]);
      const captures = new Map<string, Buffer>();
      for (const run of ["first", "fresh"] as const) {
        const gateway = await startDaemon("gateway");
        try {
          const context = await browser.newContext({
            viewport,
            locale: "en-US",
            timezoneId: "UTC",
            colorScheme: "dark",
            reducedMotion: "reduce",
          });
          try {
            const page = await context.newPage();
            const capture = async (name: string) => {
              const path = `${directory}/${name}.png`;
              await expect(
                page.locator("input:focus, textarea:focus, [contenteditable]:focus"),
              ).toHaveCount(0);
              const image = await page.screenshot({
                ...(run === "first" ? { path } : {}),
                animations: "disabled",
                caret: "initial",
              });
              if (run === "first") captures.set(name, image);
              else
                expect(
                  image.equals(captures.get(name) ?? Buffer.alloc(0)),
                  `${name} fresh daemon and browser capture`,
                ).toBe(true);
              return image;
            };
            await renderFixture(page);
            await page.goto(gateway.url);
            await signIn(page, gateway.tokens.operator);
            await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
            const directory = "docs/internal/console-redesign/current";
            await mkdir(directory, { recursive: true });
            await page.goto(new URL(entry.path, gateway.url).href);
            await expect(page.locator("#main")).not.toContainText("Loading…");
            await page.evaluate(() => document.fonts.ready);
            await settled(page);
            const headings: Record<string, string> = {
              "1-overview": "Overview",
              "2-fleet": "Fleet",
              "3-worker": "mac-studio-01",
              "4-device-screen-drawer": "mac-studio-01",
              "5-leases": "Leases",
              "6-lease-drawer": "Leases",
              "7-baselines": "Baselines",
              "8-activity": "Activity",
              inbox: "Inbox",
              queue: "Queue",
              usage: "Usage",
              "not-found": "Page not found",
            };
            await expect(
              page.locator("#main").getByRole("heading", {
                level: 1,
                name: headings[entry.name] ?? entry.name,
                includeHidden: true,
              }),
            ).toBeAttached();
            if (entry.name === "1-overview") {
              await expect(page.getByRole("link", { name: "Open Fleet" })).toBeVisible();
              await expect(
                page.locator("main table").filter({ hasText: "mac-studio-01" }).locator("tbody tr"),
              ).toHaveCount(8);
            }
            if (entry.name === "3-worker") {
              await expect(page.getByRole("tab", { name: "Devices" })).toHaveAttribute(
                "aria-selected",
                "true",
              );
              await expect(page.locator("main tbody tr")).toHaveCount(2);
            }
            if (entry.name === "2-fleet") {
              await expect(page.getByText("Szymons-MacBook-Pro.local")).toBeVisible();
              await expect(page.getByText("91%", { exact: true })).toBeVisible();
              await expect(page.locator("main tbody tr")).toHaveCount(8);
              for (const [worker, state] of [
                ["mac-studio-02", "2 / 20"],
                ["mac-mini-ci-02", "disk 91%"],
                ["mbp-lab-03", "drained"],
                ["Szymons-MacBook-Pro.local", "disconnected"],
              ] as const) {
                await expect(
                  page.locator("main tbody tr").filter({ hasText: worker }),
                ).toContainText(state);
              }
            }
            if (entry.name === "4-device-screen-drawer") {
              await expect(page.getByRole("dialog")).toBeVisible();
              await expect(page.getByRole("dialog")).toContainText(
                "Streaming is off on mac-studio-01.",
              );
              await expect(page.locator("main tbody tr")).toHaveCount(2);
              await expect(page.getByRole("tab", { name: "Screen" })).toHaveAttribute(
                "aria-selected",
                "true",
              );
            }
            if (entry.name === "5-leases") {
              await expect(page.locator("main tbody tr")).toHaveCount(14);
              for (const holder of [
                "claude-code:checkout-flow",
                "codex:8c1e2f4a-0b7d-4e21-9c3a-5f6d7e8a9b0c",
                "cursor:nav-redesign",
                "pi:release",
                "ci-nightly",
                "mcp:48213",
                "release-bot",
                "cursor/settings-a11y",
                "claude-code:onboarding-copy",
                "codex:cache",
                "ci/smoke",
                "claude-code:push",
                "codex:i18n",
                "claude-code:3f2a9c1e-7b44-4d0e-a2f1-0c9d8e7f91c4",
              ]) {
                await expect(page.locator(`main a[title="${holder}"]`)).toHaveCount(1);
              }
            }
            if (entry.name === "6-lease-drawer") {
              await expect(page.getByRole("dialog")).toBeVisible();
              await expect(page.getByRole("dialog")).toContainText("lse_1");
              await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute(
                "aria-selected",
                "true",
              );
            }
            if (entry.name === "7-baselines") {
              await expect(page.locator("main tbody tr")).toHaveCount(9);
              for (const name of [
                "ios-18.4-iphone16",
                "ios-18.4-iphone16pro",
                "ios-18.4-ipadair11",
                "ios-17.5-iphone15",
                "android-35-pixel9",
                "android-35-pixel9pro",
                "android-35-pixel8",
                "android-34-pixel8",
                "android-35-pixeltablet",
              ]) {
                await expect(page.getByText(name, { exact: true })).toBeVisible();
              }
              await expect(
                page.locator("main tbody tr").filter({ hasText: "ios-17.5-iphone15" }),
              ).toContainText("Runtime was replaced");
              await expect(
                page.locator("main tbody tr").filter({ hasText: "android-35-pixel8" }),
              ).not.toContainText("stale");
              await expect(page.getByText("stale", { exact: true })).toHaveCount(1);
            }
            if (entry.name === "inbox")
              await expect(page.getByText("Nothing needs you.")).toBeVisible();
            if (entry.name === "queue")
              await expect(page.getByText("No requests are waiting.")).toBeVisible();
            if (entry.name === "usage")
              await expect(page.getByText("No requests in this range.")).toBeVisible();
            if (entry.name === "8-activity") {
              await expect(page.getByText("lease.granted").first()).toBeVisible();
              await expect(page.locator(".chart-summary")).toHaveText(
                "60 events in the last hour; the busiest minute was 18:20, with 1.",
              );
              await expect(page.locator(".chart-data tbody tr")).toHaveCount(60);
              await expect(page.locator(".chart-data tbody tr").first()).toContainText("18:20");
              await expect(page.locator(".chart-data tbody tr").last()).toContainText("17:21");
              const stream = await page.evaluate(async (token) => {
                const controller = new AbortController();
                const response = await fetch("/v1/events/stream", {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: controller.signal,
                });
                const result = {
                  status: response.status,
                  contentType: response.headers.get("content-type"),
                  date: response.headers.get("date"),
                };
                controller.abort();
                const refused = await fetch("/v1/events/stream", {
                  headers: { Authorization: "Bearer invalid-render-token" },
                });
                const history = await fetch("/v1/events", {
                  headers: { Authorization: `Bearer ${token}` },
                });
                const refusedHistory = await fetch("/v1/events", {
                  headers: { Authorization: "Bearer invalid-render-token" },
                });
                const historyBody = (await history.json()) as { events: { timestamp: number }[] };
                return {
                  ...result,
                  refusedStatus: refused.status,
                  historyStatus: history.status,
                  refusedHistoryStatus: refusedHistory.status,
                  historyContentType: history.headers.get("content-type"),
                  historyDate: history.headers.get("date"),
                  browserNow: Date.now(),
                  historyTimes: historyBody.events.map((event) => event.timestamp),
                };
              }, gateway.tokens.operator);
              expect(stream, "authorized live stream follows the fixture timeline").toEqual({
                status: 200,
                contentType: "text/event-stream",
                date: "Fri, 02 Oct 2026 18:20:00 GMT",
                refusedStatus: 401,
                historyStatus: 200,
                refusedHistoryStatus: 401,
                historyContentType: "application/json",
                historyDate: "Fri, 02 Oct 2026 18:20:00 GMT",
                browserNow: Date.parse("2026-10-02T18:20:00.000Z"),
                historyTimes: Array.from(
                  { length: 60 },
                  (_, index) => Date.parse("2026-10-02T18:20:00.000Z") - index * 60_000,
                ),
              });
            }
            const suffix = viewport.width === 1440 ? "" : `-${viewport.width}x${viewport.height}`;
            await expect(
              page.locator("input:focus, textarea:focus, [contenteditable]:focus"),
            ).toHaveCount(0);
            // why: Playwright's caret hiding repaints unfocused input borders differently on alternating captures.
            const first = await capture(`${entry.name}${suffix}`);
            const second = await page.screenshot({ animations: "disabled", caret: "initial" });
            expect(second, `${entry.name} repeated capture`).toEqual(first);
            if (run === "first")
              await testInfo.attach(entry.name, {
                path: `${directory}/${entry.name}${suffix}.png`,
                contentType: "image/png",
              });
            if (entry.name === "not-found" && viewport.width === 1440) {
              await page.getByRole("button", { name: "Sign out" }).click();
              await expect(page.getByLabel("Operator token")).toBeVisible();
              await capture("sign-in");
              await signIn(page, gateway.tokens.operator);
              await expect(
                page.getByRole("heading", { level: 1, name: "Page not found" }),
              ).toBeVisible();
              await page.goto(gateway.url);
              await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
            }
            if (entry.name === "5-leases" && viewport.width === 1440) {
              for (const [scenario, expected] of [
                ["empty", "No leases."],
                ["long", "x".repeat(256)],
                ["refused", "Fixture route refused"],
              ] as const) {
                await page.unrouteAll({ behavior: "wait" });
                await renderFixture(page, scenario);
                await page.goto(new URL("/leases", gateway.url).href);
                if (scenario === "long")
                  await expect(page.locator(`[title="${expected}"]`)).toBeVisible();
                else await expect(page.getByText(expected, { exact: true })).toBeVisible();
                await page.evaluate(() => document.fonts.ready);
                await settled(page);
                await capture(`leases-${scenario}`);
              }
            }
            if (entry.name === "8-activity" && viewport.width === 1440) {
              await page.evaluate(async (token) => {
                const response = await fetch("/v1/events/stream", {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok || response.body === null) throw new Error("stream did not open");
                (
                  window as typeof window & {
                    renderReader: ReadableStreamDefaultReader<Uint8Array>;
                  }
                ).renderReader = response.body.getReader();
              }, gateway.tokens.operator);
              const token = await mintJoinToken(gateway);
              const worker = await startDaemon("worker", {
                config: {
                  gateway: {
                    label: "render-live-worker",
                    token,
                    url: `ws://127.0.0.1:${gateway.port}`,
                  },
                },
              });
              try {
                const live = await page.evaluate(async () => {
                  const reader = (
                    window as typeof window & {
                      renderReader: ReadableStreamDefaultReader<Uint8Array>;
                    }
                  ).renderReader;
                  const decoder = new TextDecoder();
                  let pending = "";
                  while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) throw new Error("stream closed before worker.connected");
                    pending += decoder.decode(chunk.value, { stream: true });
                    let end: number;
                    while ((end = pending.indexOf("\n\n")) !== -1) {
                      const frame = pending.slice(0, end);
                      pending = pending.slice(end + 2);
                      if (!frame.split("\n").includes("event: worker.connected")) continue;
                      const line = frame.split("\n").find((part) => part.startsWith("data: "));
                      if (line === undefined) throw new Error("worker.connected missing data");
                      return JSON.parse(line.slice(6)) as {
                        event: string;
                        timestamp: number;
                        id: string;
                        seq: number;
                        payload: { label: string; workerId: string };
                      };
                    }
                  }
                });
                expect(live.event).toBe("worker.connected");
                expect(live.payload.label).toBe("render-live-worker");
                expect(live.payload.workerId).toBeTruthy();
                expect(live.id).toBeTruthy();
                expect(typeof live.seq).toBe("number");
                expect(live.timestamp, "real live event uses the fixture clock").toBe(
                  Date.parse("2026-10-02T18:20:00.000Z"),
                );
                await expect(page.getByText("worker.connected").first()).toBeVisible();
              } finally {
                await worker.dispose();
              }
            }
          } finally {
            await context.close();
          }
        } finally {
          await gateway.dispose();
        }
      }
    });
  }
}
