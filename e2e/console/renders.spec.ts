import { mkdir, writeFile } from "node:fs/promises";

import { compareCaptures, visibleState } from "./capture-comparison.js";
import { expect, mintJoinToken, settled, signIn, startDaemon, test } from "./fixtures.js";
import { renderCases, renderFixture, renderScenario } from "./render-fixtures.js";

test.use({ locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce" });

const cases = await renderCases();
const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("same-source captures use fixed perceptual matching and exact visible state", async ({
  page,
}) => {
  const images = await page.evaluate(() => {
    const make = (changed: number, delta: number, alpha = 255, width = 40) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(width, 1);
      for (let i = 0; i < width; i += 1) {
        image.data.set([100 + (i < changed ? delta : 0), 100, 100, i === 0 ? alpha : 255], i * 4);
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    };
    return [make(0, 0), make(33, 1), make(1, 100), make(0, 0, 254), make(0, 0, 255, 39)];
  });
  const [base, below, above, alpha, dimensions] = images.map((image) =>
    Buffer.from(image, "base64"),
  );
  for (const [label, image, expected] of [
    ["identical", base, true],
    ["33 below-threshold flat pixels", below, true],
    ["one above-threshold flat pixel", above, false],
    ["alpha change", alpha, false],
    ["dimensions", dimensions, false],
  ] as const) {
    expect(compareCaptures(base!, image!, "visible", "visible").matches, label).toBe(expected);
  }
  expect(
    compareCaptures(base!, above!, "visible", "visible").matcherPixels,
    "one flagged pixel",
  ).toBe(1);
  const edges = await page.evaluate(() => {
    const make = (center: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 7;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(7, 7);
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const value = x < 3 ? 0 : x > 3 ? 255 : y === 3 ? center : 60 + y * 10;
          image.data.set([value, value, value, 255], (y * 7 + x) * 4);
        }
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    };
    return [make(100), make(180)];
  });
  const edge = compareCaptures(
    Buffer.from(edges[0]!, "base64"),
    Buffer.from(edges[1]!, "base64"),
    "visible",
    "visible",
  );
  expect(edge.changedPixels, "AA raw changed pixels").toBe(1);
  expect(edge.recognizedEdgePixels, "recognized AA edge").toBe(1);
  expect(edge.matcherPixels, "AA is not matcher-flagged").toBe(0);
  expect(edge.matches, "AA edge accepted").toBe(true);
  for (const [label, left, right, changedPixels, maxRgbDelta, matches] of [
    [
      "half-transparent one-level RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNIEfnQAAAEMQHp56QzagAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNIFfnQAAAENQHqJEibAAAAAABJRU5ErkJggg==",
      1,
      1,
      true,
    ],
    [
      "nearly transparent ten-level RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPgSjnBCAAC6gE4rxOTiwAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWMQSTnBCAADEgFCNWn++AAAAABJRU5ErkJggg==",
      1,
      10,
      true,
    ],
    [
      "transparent RGB",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWMQ0bBhAAABRQB5yEL59wAAAABJRU5ErkJggg==",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWPQsAlgAAAB+QC1yr0tZgAAAABJRU5ErkJggg==",
      1,
      20,
      true,
    ],
  ] as const) {
    const result = compareCaptures(
      Buffer.from(left, "base64"),
      Buffer.from(right, "base64"),
      "visible",
      "visible",
    );
    expect(result.changedPixels, `${label} changed pixels`).toBe(changedPixels);
    expect(result.maxRgbDelta, `${label} raw RGB delta`).toBe(maxRgbDelta);
    expect(result.alphaChanged, `${label} alpha`).toBe(false);
    expect(result.matches, `${label} fixed matcher`).toBe(matches);
  }
  expect(compareCaptures(base!, base!, "visible", "changed").matches, "visible state").toBe(false);
  await page.setContent(
    '<main><h1>Overview</h1><p style="color: black; width: 100px">8 workers</p><svg width="40" height="40"><path d="M0 0 L40 0 L40 40 L0 40 Z" /></svg></main>',
  );
  const original = await visibleState(page);
  for (const [label, change] of [
    ["visible heading", "heading"],
    ["visible data", "data"],
    ["computed presentation", "style"],
    ["geometry", "geometry"],
    ["chart path", "path"],
  ] as const) {
    await page.evaluate((kind) => {
      const heading = document.querySelector("h1")!;
      const paragraph = document.querySelector("p")!;
      heading.textContent = kind === "heading" ? "Different" : "Overview";
      paragraph.textContent = kind === "data" ? "9 workers" : "8 workers";
      paragraph.style.color = kind === "style" ? "red" : "black";
      paragraph.style.width = kind === "geometry" ? "101px" : "100px";
      document
        .querySelector("path")!
        .setAttribute(
          "d",
          kind === "path" ? "M0 0 L40 0 L40 40 L20 20 L0 40 Z" : "M0 0 L40 0 L40 40 L0 40 Z",
        );
    }, change);
    const changed = await visibleState(page);
    const result = compareCaptures(base!, base!, original, changed);
    expect(result.changedPixels, `${label} uses identical pixels`).toBe(0);
    expect(result.stateMatches, `${label} exact state`).toBe(false);
    expect(result.matches, `${label} cannot use raster allowance`).toBe(false);
  }
  await page.setContent('<main style="height: 2000px"><p>Visible geometry</p></main>');
  const beforeScroll = await visibleState(page);
  await page.evaluate(() => window.scrollBy(0, 1));
  const afterScroll = await visibleState(page);
  const moved = compareCaptures(base!, base!, beforeScroll, afterScroll);
  expect(moved.changedPixels, "scroll-only geometry uses identical pixels").toBe(0);
  expect(moved.stateMatches, "scroll-only HTML geometry exact state").toBe(false);
  expect(moved.matches, "scroll-only geometry cannot use raster allowance").toBe(false);
});

async function connectedEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
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
      return JSON.parse(line.slice(6)) as Record<string, unknown>;
    }
  }
}

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
      expect(
        cases
          .filter(({ name }) =>
            ["4-device-screen-drawer", "6-lease-drawer", "7-baselines"].includes(name),
          )
          .map(({ name, path }) => [name, path]),
        "reference 4, 6 and 7 use existing drawer and ready/stale table routes",
      ).toEqual([
        ["4-device-screen-drawer", "/fleet/wrk_1/dev_1?tab=devices&drawer=screen"],
        ["6-lease-drawer", "/leases/lse_1/"],
        ["7-baselines", "/baselines"],
      ]);
      const captures = new Map<string, { image: Buffer; state: unknown; pose: unknown }>();
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
            const capturePose = () =>
              page.evaluate(() => ({
                windowFocused: document.hasFocus(),
                active: document.activeElement?.outerHTML.slice(0, 500),
                focusVisible: document.activeElement?.matches(":focus-visible"),
                animations: document.getAnimations().map((animation) => ({
                  playState: animation.playState,
                  currentTime: animation.currentTime,
                  target:
                    animation.effect instanceof KeyframeEffect
                      ? animation.effect.target?.outerHTML.slice(0, 500)
                      : null,
                })),
              }));
            const snapshot = async (path?: string) => {
              await expect(
                page.locator("input:focus, textarea:focus, [contenteditable]:focus"),
              ).toHaveCount(0);
              const state = await visibleState(page);
              const before = await capturePose();
              const image = await page.screenshot({
                ...(path === undefined ? {} : { path }),
                animations: "disabled",
                caret: "initial",
              });
              const after = await capturePose();
              return { image, state, pose: { before, after } };
            };
            const assertCapture = async (
              name: string,
              kind: "fresh" | "repeated",
              first: { image: Buffer; state: unknown; pose: unknown },
              second: { image: Buffer; state: unknown; pose: unknown },
            ) => {
              const comparison = compareCaptures(
                first.image,
                second.image,
                first.state,
                second.state,
              );
              const evidenceName = `${run}-${name}-${kind}`;
              const retainPair =
                !comparison.matches ||
                ((name === "1-overview-1280x800" || name === "4-device-screen-drawer-1280x800") &&
                  run === "fresh");
              if (retainPair) {
                const firstPath = testInfo.outputPath(`${evidenceName}-first.png`);
                const secondPath = testInfo.outputPath(`${evidenceName}-second.png`);
                await writeFile(firstPath, first.image);
                await writeFile(secondPath, second.image);
                await testInfo.attach(`${name}-${kind}-first`, {
                  path: firstPath,
                  contentType: "image/png",
                });
                await testInfo.attach(`${name}-${kind}-second`, {
                  path: secondPath,
                  contentType: "image/png",
                });
              }
              const comparisonPath = testInfo.outputPath(`${evidenceName}-comparison.json`);
              await writeFile(comparisonPath, JSON.stringify(comparison, null, 2));
              await testInfo.attach(`${name}-${kind}-comparison`, {
                path: comparisonPath,
                contentType: "application/json",
              });
              if (!comparison.matches) {
                await testInfo.attach(`${name}-${kind}-visible-state`, {
                  body: JSON.stringify({ first: first.state, second: second.state }),
                  contentType: "application/json",
                });
                await testInfo.attach(`${name}-${kind}-capture-pose`, {
                  body: JSON.stringify({ first: first.pose, second: second.pose }),
                  contentType: "application/json",
                });
              }
              expect(
                comparison.matches,
                `${name} ${kind} capture: ${JSON.stringify(comparison)}`,
              ).toBe(true);
            };
            const capture = async (name: string) => {
              const current = await snapshot(
                run === "first" ? `${directory}/${name}.png` : undefined,
              );
              if (run === "first") captures.set(name, current);
              else {
                const previous = captures.get(name);
                expect(previous, `${name} first capture exists`).toBeDefined();
                await assertCapture(name, "fresh", previous!, current);
              }
              return current;
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
              await expect(page.locator("main .chip-mark").first()).toHaveCSS(
                "font-family",
                /Geist Mono/,
              );
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
              const baselineReply = await page.evaluate(async (token) => {
                const accepted = await fetch("/v1/baselines", {
                  headers: { Authorization: `Bearer ${token}` },
                });
                const refused = await fetch("/v1/baselines", {
                  headers: { Authorization: "Bearer invalid-render-token" },
                });
                return {
                  status: accepted.status,
                  contentType: accepted.headers.get("content-type"),
                  date: accepted.headers.get("date"),
                  refusedStatus: refused.status,
                  baselines: (
                    (await accepted.json()) as {
                      baselines: { name: string; staleReason?: string }[];
                    }
                  ).baselines.map(({ name, staleReason }) => [name, staleReason ?? null]),
                };
              }, gateway.tokens.operator);
              expect(
                baselineReply,
                "authorized ready/stale data and refused baseline route",
              ).toEqual({
                status: 200,
                contentType: "application/json",
                date: "Fri, 02 Oct 2026 18:20:00 GMT",
                refusedStatus: 401,
                baselines: [
                  ["ios-18.4-iphone16", null],
                  ["ios-18.4-iphone16pro", null],
                  ["ios-18.4-ipadair11", null],
                  ["ios-17.5-iphone15", "Runtime was replaced"],
                  ["android-35-pixel9", null],
                  ["android-35-pixel9pro", null],
                  ["android-35-pixel8", null],
                  ["android-34-pixel8", null],
                  ["android-35-pixeltablet", null],
                ],
              });
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
            if (entry.name === "1-overview" && viewport.width === 1280 && run === "first") {
              expect(
                compareCaptures(first.image, first.image, first.state, first.state),
                "real Overview PNG compares identical to itself",
              ).toEqual({
                dimensionsMatch: true,
                changedPixels: 0,
                recognizedEdgePixels: 0,
                matcherPixels: 0,
                edgeMaxRgbDelta: 0,
                matcherMaxRgbDelta: 0,
                maxRgbDelta: 0,
                alphaChanged: false,
                matches: true,
                stateMatches: true,
              });
            }
            if (entry.name === "1-overview" && viewport.width === 1440 && run === "first") {
              await page.evaluate(() => {
                const svg = document.querySelector(".recharts-surface:has(.recharts-area-area)")!;
                const path = svg.querySelector(".recharts-area-area")!;
                const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                use.id = "capture-generated-id-reference";
                use.style.display = "none";
                use.setAttribute("href", `#${path.id}`);
                svg.append(use);
              });
              const identityBefore = await visibleState(page);
              const oldId = await page.evaluate(() => {
                const path = document.querySelector(".recharts-area-area")!;
                const old = path.id;
                path.id = "recharts-area-_r_capture_";
                document
                  .querySelector("#capture-generated-id-reference")!
                  .setAttribute("href", `#${path.id}`);
                return old;
              });
              const identityRenamed = await visibleState(page);
              await page.locator("#capture-generated-id-reference").evaluate((element) => {
                element.setAttribute("href", "#different-paint-target");
              });
              const identityRewired = await visibleState(page);
              await page.evaluate((id) => {
                document.querySelector(".recharts-area-area")!.id = id;
                document.querySelector("#capture-generated-id-reference")!.remove();
              }, oldId);
              expect(
                compareCaptures(first.image, first.image, identityBefore, identityRenamed).matches,
                "generated SVG id and reference renamed consistently",
              ).toBe(true);
              expect(
                compareCaptures(first.image, first.image, identityRenamed, identityRewired).matches,
                "generated SVG reference rewiring remains visible",
              ).toBe(false);
              const original = await visibleState(page);
              const heading = page.locator("main h1");
              await heading.evaluate((element) => {
                element.textContent = "Changed overview";
              });
              const changed = await visibleState(page);
              await heading.evaluate((element) => {
                element.textContent = "Overview";
              });
              const proof = compareCaptures(first.image, first.image, original, changed);
              expect(proof.changedPixels, "visible mutation uses identical capture pixels").toBe(0);
              expect(proof.stateMatches, "visible overview heading mutation").toBe(false);
              expect(proof.matches, "visible mutation cannot use raster allowance").toBe(false);
              for (const [label, selector, attribute, replacement] of [
                ["real chart path", ".recharts-area-area", "d", "M0,0 L1,1"],
                ["hidden clip geometry", ".recharts-surface clipPath rect", "width", "1"],
                [
                  "hidden clip style",
                  ".recharts-surface clipPath rect",
                  "style",
                  "transform: translate(3px)",
                ],
                ["hidden clip data", ".recharts-surface clipPath rect", "data-paint", "changed"],
              ] as const) {
                const target = page.locator(selector).first();
                await expect(target, label).toHaveCount(1);
                const before = await visibleState(page);
                const previous = await target.evaluate(
                  (element, { name, value }) => {
                    const old = element.getAttribute(name);
                    element.setAttribute(name, value);
                    return old;
                  },
                  { name: attribute, value: replacement },
                );
                const after = await visibleState(page);
                await target.evaluate(
                  (element, { name, value }) => {
                    if (value === null) element.removeAttribute(name);
                    else element.setAttribute(name, value);
                  },
                  { name: attribute, value: previous },
                );
                const mutated = compareCaptures(first.image, first.image, before, after);
                expect(mutated.changedPixels, `${label} uses identical capture pixels`).toBe(0);
                expect(mutated.stateMatches, `${label} exact paint inputs`).toBe(false);
                expect(mutated.matches, `${label} rejected independently of pixels`).toBe(false);
              }
              for (const kind of [
                "absolute CSS",
                "relative CSS",
                "absolute href",
                "relative href",
              ] as const) {
                await page.evaluate((reference) => {
                  const svg = document.querySelector(".sidebar-search .icon")!;
                  const path = svg.querySelector("path")!;
                  const hidden = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                  hidden.id = "capture-reference-definitions";
                  hidden.style.cssText = "position:absolute;width:0;height:0";
                  const definition = reference.endsWith("CSS")
                    ? document.createElementNS("http://www.w3.org/2000/svg", "clipPath")
                    : (path.cloneNode(true) as Element);
                  definition.id = "capture-reference-target";
                  if (reference.endsWith("CSS")) {
                    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                    rect.setAttribute("width", "16");
                    rect.setAttribute("height", "16");
                    definition.append(rect);
                  }
                  hidden.append(definition);
                  document.body.append(hidden);
                  const address = reference.startsWith("absolute")
                    ? `${location.origin}${location.pathname}#capture-reference-target`
                    : `./#capture-reference-target`;
                  if (reference.endsWith("CSS")) {
                    path.setAttribute(
                      "data-capture-old-clip",
                      path.getAttribute("clip-path") ?? "",
                    );
                    path.setAttribute("clip-path", `url("${address}")`);
                  } else {
                    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                    use.id = "capture-reference-use";
                    use.setAttribute("href", address);
                    svg.append(use);
                  }
                }, kind);
                const paintTarget = kind.endsWith("CSS")
                  ? page.locator(".sidebar-search .icon path")
                  : page.locator("#capture-reference-use");
                const referenceAttribute = kind.endsWith("CSS") ? "clip-path" : "href";
                await expect(paintTarget).toHaveAttribute(
                  referenceAttribute,
                  /capture-reference-target/,
                );
                expect(
                  await paintTarget.evaluate((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                  }),
                  `${kind} has a paintable target`,
                ).toBe(true);
                const before = await visibleState(page);
                const definition = page.locator(
                  kind.endsWith("CSS")
                    ? "#capture-reference-target rect"
                    : "#capture-reference-target",
                );
                await definition.evaluate((element, css) => {
                  element.setAttribute(css ? "width" : "d", css ? "1" : "M0 0L1 1");
                }, kind.endsWith("CSS"));
                const after = await visibleState(page);
                await expect(paintTarget).toHaveAttribute(
                  referenceAttribute,
                  /capture-reference-target/,
                );
                await page.evaluate(() => {
                  const path = document.querySelector(".sidebar-search .icon path")!;
                  const old = path.getAttribute("data-capture-old-clip");
                  if (old !== null) {
                    if (old === "") path.removeAttribute("clip-path");
                    else path.setAttribute("clip-path", old);
                    path.removeAttribute("data-capture-old-clip");
                  }
                  document.querySelector("#capture-reference-use")?.remove();
                  document.querySelector("#capture-reference-definitions")!.remove();
                });
                const mutated = compareCaptures(first.image, first.image, before, after);
                expect(
                  mutated.changedPixels,
                  `${kind} definition uses identical capture pixels`,
                ).toBe(0);
                expect(mutated.stateMatches, `${kind} definition exact paint inputs`).toBe(false);
                expect(mutated.matches, `${kind} definition rejected independently of pixels`).toBe(
                  false,
                );
              }
              for (const attribute of ["href", "fill"] as const) {
                await page.evaluate((name) => {
                  const svg = document.querySelector(".recharts-surface")!;
                  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
                  use.id = "capture-external-reference";
                  use.style.display = "none";
                  use.setAttribute(
                    name,
                    name === "fill"
                      ? 'url("https://example.invalid/a.svg#paint")'
                      : "https://example.invalid/a.svg#shape",
                  );
                  svg.append(use);
                }, attribute);
                const before = await visibleState(page);
                await page.locator("#capture-external-reference").evaluate((element, name) => {
                  element.setAttribute(
                    name,
                    name === "fill"
                      ? 'url("https://example.invalid/b.svg#paint")'
                      : "https://example.invalid/b.svg#shape",
                  );
                }, attribute);
                const after = await visibleState(page);
                await page
                  .locator("#capture-external-reference")
                  .evaluate((element) => element.remove());
                const mutated = compareCaptures(first.image, first.image, before, after);
                expect(
                  mutated.changedPixels,
                  `external ${attribute} uses identical capture pixels`,
                ).toBe(0);
                expect(mutated.stateMatches, `external ${attribute} reference preserved`).toBe(
                  false,
                );
                expect(
                  mutated.matches,
                  `external ${attribute} rejected independently of pixels`,
                ).toBe(false);
              }
            }
            const second = await snapshot();
            await assertCapture(`${entry.name}${suffix}`, "repeated", first, second);
            if (run === "first")
              await testInfo.attach(entry.name, {
                path: `${directory}/${entry.name}${suffix}.png`,
                contentType: "image/png",
              });
            if (entry.name === "not-found" && viewport.width === 1440) {
              await page.getByRole("button", { name: "Sign out" }).click();
              await expect(page.getByLabel("Operator token")).toBeVisible();
              const signInCapture = await capture("sign-in");
              await assertCapture("sign-in", "repeated", signInCapture, await snapshot());
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
                await renderScenario(page, scenario);
                await page.goto(new URL("/leases", gateway.url).href);
                if (scenario === "long")
                  await expect(page.locator(`[title="${expected}"]`)).toBeVisible();
                else await expect(page.getByText(expected, { exact: true })).toBeVisible();
                await expect(page.locator(".connection [role=status]")).toHaveText("Connected");
                await page.evaluate(() => document.fonts.ready);
                await settled(page);
                const scenarioCapture = await capture(`leases-${scenario}`);
                await assertCapture(
                  `leases-${scenario}`,
                  "repeated",
                  scenarioCapture,
                  await snapshot(),
                );
              }
            }
            if (entry.name === "8-activity" && viewport.width === 1440) {
              const rawController = new AbortController();
              try {
                const rawResponse = await fetch(new URL("/v1/events/stream", gateway.url), {
                  headers: { Authorization: `Bearer ${gateway.tokens.operator}` },
                  signal: rawController.signal,
                });
                expect(rawResponse.status).toBe(200);
                expect(rawResponse.headers.get("content-type")).toBe("text/event-stream");
                if (rawResponse.body === null) throw new Error("raw stream did not open");
                const rawReader = rawResponse.body.getReader();
                await page.evaluate(async (token) => {
                  const response = await fetch("/v1/events/stream", {
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (!response.ok || response.body === null)
                    throw new Error("stream did not open");
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
                  expect(live, "live normalization preserves every other envelope field").toEqual({
                    ...(await connectedEvent(rawReader)),
                    timestamp: Date.parse("2026-10-02T18:20:00.000Z"),
                  });
                  await expect(page.getByText("worker.connected").first()).toBeVisible();
                } finally {
                  await worker.dispose();
                }
              } finally {
                rawController.abort();
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
