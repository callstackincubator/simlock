import { mkdir, writeFile } from "node:fs/promises";

import type { BrowserContext, Page, TestInfo } from "@playwright/test";

import { compareCaptures, visibleState } from "./capture-comparison.js";
import { expect, mintJoinToken, settled, signIn, startDaemon } from "./fixtures.js";
import type { RunningDaemon } from "./fixtures.js";
import type { RenderCase } from "./render-fixtures.js";
import { renderFixture, renderScenario } from "./render-fixtures.js";

// why: the render spec writes its screenshots here, beside the references they are compared with.
const DIRECTORY = "docs/internal/console-redesign/current";

export interface Capture {
  readonly image: Buffer;
  readonly state: unknown;
  readonly pose: unknown;
}

export interface RunJob {
  readonly captures: Map<string, Capture>;
  readonly context: BrowserContext;
  readonly entry: RenderCase;
  readonly gateway: RunningDaemon;
  readonly run: "first" | "fresh";
  readonly testInfo: TestInfo;
  readonly viewport: { readonly width: number; readonly height: number };
}

export function expectCaseList(cases: readonly RenderCase[]): void {
  expect(
    cases.map(({ name }) => name),
    "named reference and unreferenced pages",
  ).toEqual([
    "1-overview",
    "2-fleet",
    "3-worker",
    "4-streaming",
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
      .filter(({ name }) => ["4-streaming", "6-lease-drawer", "7-baselines"].includes(name))
      .map(({ name, path }) => [name, path]),
    "reference 4 is the streaming page; 6 and 7 use existing drawer and ready/stale table routes",
  ).toEqual([
    ["4-streaming", "/fleet/wrk_1/devices/dev_1/"],
    ["6-lease-drawer", "/leases/lse_1/"],
    ["7-baselines", "/baselines"],
  ]);
}

type PageCheck = (page: Page, gateway: RunningDaemon) => Promise<void>;

async function checkOverview(page: Page): Promise<void> {
  await expect(page.getByRole("link", { name: "Open fleet" })).toBeVisible();
  await expect(page.locator("main .worker-tile")).toHaveCount(8);
  await expect(page.locator("main table:not(.chart-data)")).toHaveCount(0);
}

async function checkWorker(page: Page): Promise<void> {
  await expect(page.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("main .worker-device")).toHaveCount(2);
}

async function checkFleet(page: Page): Promise<void> {
  await expect(page.getByText("Szymons-MacBook-Pro.local")).toBeVisible();
  await expect(page.getByText("91%", { exact: true })).toBeVisible();
  await expect(page.locator("main .fleet-card")).toHaveCount(8);
  for (const [worker, state] of [
    ["mac-studio-02", "/ 20"],
    ["mac-mini-ci-02", "disk 91%"],
    ["mbp-lab-03", "drained"],
    ["Szymons-MacBook-Pro.local", "disconnected"],
  ] as const) {
    await expect(page.locator("main .fleet-card").filter({ hasText: worker })).toContainText(state);
  }
}

async function checkStreaming(page: Page): Promise<void> {
  await expect(page.locator(".phone-canvas")).toBeVisible();
  await expect(page.locator(".screen-pills")).toContainText("LIVE");
  await expect(page.getByLabel("Holder")).toContainText("claude-code:checkout-flow");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { streamFrames?: number }).streamFrames))
    .toBe(10);
  await expect(page.locator(".screen-pills")).toContainText("Mb/s");
}

async function checkLeases(page: Page): Promise<void> {
  await expect(page.locator("main tbody tr")).toHaveCount(14);
  await expect(page.locator("main .chip-mark").first()).toHaveCSS("font-family", /Geist Mono/);
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

async function checkLeaseDrawer(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  const inspector =
    width >= 1280 ? page.locator("aside .lease-inspector") : page.getByRole("dialog");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("lse_1");
  await expect(inspector.getByRole("button", { name: "Copy id" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
}

async function checkBaselines(page: Page, gateway: RunningDaemon): Promise<void> {
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
  expect(baselineReply, "authorized ready/stale data and refused baseline route").toEqual({
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

async function checkInbox(page: Page): Promise<void> {
  await expect(page.getByText("Nothing needs you.")).toBeVisible();
}

async function checkQueue(page: Page): Promise<void> {
  await expect(page.getByText("No requests are waiting.")).toBeVisible();
}

async function checkUsage(page: Page): Promise<void> {
  await expect(page.getByText("No requests in this range.")).toBeVisible();
}

async function checkActivity(page: Page, gateway: RunningDaemon): Promise<void> {
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

const PAGE_CHECKS: Readonly<Record<string, PageCheck>> = {
  "1-overview": checkOverview,
  "2-fleet": checkFleet,
  "3-worker": checkWorker,
  "4-streaming": checkStreaming,
  "5-leases": checkLeases,
  "6-lease-drawer": checkLeaseDrawer,
  "7-baselines": checkBaselines,
  "8-activity": checkActivity,
  inbox: checkInbox,
  queue: checkQueue,
  usage: checkUsage,
};

const HEADINGS: Readonly<Record<string, string>> = {
  "1-overview": "Overview",
  "2-fleet": "Fleet",
  "3-worker": "mac-studio-01",
  "4-streaming": "mac-studio-01",
  "5-leases": "Leases",
  "6-lease-drawer": "Leases",
  "7-baselines": "Baselines",
  "8-activity": "Activity",
  inbox: "Inbox",
  queue: "Queue",
  usage: "Usage",
  "not-found": "Page not found",
};

async function openCase(page: Page, job: RunJob): Promise<void> {
  const { entry, gateway } = job;
  await renderFixture(page);
  await page.goto(gateway.url);
  await signIn(page, gateway.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await mkdir(DIRECTORY, { recursive: true });
  await page.goto(new URL(entry.path, gateway.url).href);
  await expect(page.locator("#main")).not.toContainText("Loading…");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  await expect(
    page.locator("#main").getByRole("heading", {
      level: 1,
      name: HEADINGS[entry.name] ?? entry.name,
      includeHidden: true,
    }),
  ).toBeAttached();
  await PAGE_CHECKS[entry.name]?.(page, gateway);
}

interface Capturer {
  readonly assertCapture: (
    name: string,
    kind: "fresh" | "repeated",
    first: Capture,
    second: Capture,
  ) => Promise<void>;
  readonly capture: (name: string) => Promise<Capture>;
  readonly snapshot: (path?: string) => Promise<Capture>;
}

function createCapturer(page: Page, job: RunJob): Capturer {
  const { captures, run, testInfo } = job;
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
  const snapshot = async (path?: string): Promise<Capture> => {
    await expect(page.locator("input:focus, textarea:focus, [contenteditable]:focus")).toHaveCount(
      0,
    );
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
    first: Capture,
    second: Capture,
  ) => {
    const comparison = compareCaptures(first.image, second.image, first.state, second.state);
    const evidenceName = `${run}-${name}-${kind}`;
    const retainPair =
      !comparison.matches ||
      ((name === "1-overview-1280x800" || name === "4-streaming-1280x800") && run === "fresh");
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
    expect(comparison.matches, `${name} ${kind} capture: ${JSON.stringify(comparison)}`).toBe(true);
  };
  const capture = async (name: string) => {
    const current = await snapshot(run === "first" ? `${DIRECTORY}/${name}.png` : undefined);
    if (run === "first") captures.set(name, current);
    else {
      const previous = captures.get(name);
      expect(previous, `${name} first capture exists`).toBeDefined();
      await assertCapture(name, "fresh", previous!, current);
    }
    return current;
  };
  return { assertCapture, capture, snapshot };
}

async function proveSelfComparison(first: Capture): Promise<void> {
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

async function proveIdentityRenames(page: Page, first: Capture): Promise<void> {
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
    document.querySelector("#capture-generated-id-reference")!.setAttribute("href", `#${path.id}`);
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
}

async function proveVisibleMutation(page: Page, first: Capture): Promise<void> {
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
}

async function proveHiddenPaintInputs(page: Page, first: Capture): Promise<void> {
  for (const [label, selector, attribute, replacement] of [
    ["real chart path", ".recharts-area-area", "d", "M0,0 L1,1"],
    ["hidden clip geometry", ".recharts-surface clipPath rect", "width", "1"],
    ["hidden clip style", ".recharts-surface clipPath rect", "style", "transform: translate(3px)"],
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
}

async function proveExternalReferences(page: Page, first: Capture): Promise<void> {
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
    await page.locator("#capture-external-reference").evaluate((element) => element.remove());
    const mutated = compareCaptures(first.image, first.image, before, after);
    expect(mutated.changedPixels, `external ${attribute} uses identical capture pixels`).toBe(0);
    expect(mutated.stateMatches, `external ${attribute} reference preserved`).toBe(false);
    expect(mutated.matches, `external ${attribute} rejected independently of pixels`).toBe(false);
  }
}

type ReferenceKind = "absolute CSS" | "relative CSS" | "absolute href" | "relative href";

async function addReferenceTarget(page: Page, kind: ReferenceKind): Promise<void> {
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
      path.setAttribute("data-capture-old-clip", path.getAttribute("clip-path") ?? "");
      path.setAttribute("clip-path", `url("${address}")`);
    } else {
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.id = "capture-reference-use";
      use.setAttribute("href", address);
      svg.append(use);
    }
  }, kind);
}

async function removeReferenceTarget(page: Page): Promise<void> {
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
}

async function proveReferenceDefinition(
  page: Page,
  first: Capture,
  kind: ReferenceKind,
): Promise<void> {
  await addReferenceTarget(page, kind);
  const paintTarget = kind.endsWith("CSS")
    ? page.locator(".sidebar-search .icon path")
    : page.locator("#capture-reference-use");
  const referenceAttribute = kind.endsWith("CSS") ? "clip-path" : "href";
  await expect(paintTarget).toHaveAttribute(referenceAttribute, /capture-reference-target/);
  expect(
    await paintTarget.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }),
    `${kind} has a paintable target`,
  ).toBe(true);
  const before = await visibleState(page);
  const definition = page.locator(
    kind.endsWith("CSS") ? "#capture-reference-target rect" : "#capture-reference-target",
  );
  await definition.evaluate((element, css) => {
    element.setAttribute(css ? "width" : "d", css ? "1" : "M0 0L1 1");
  }, kind.endsWith("CSS"));
  const after = await visibleState(page);
  await expect(paintTarget).toHaveAttribute(referenceAttribute, /capture-reference-target/);
  await removeReferenceTarget(page);
  const mutated = compareCaptures(first.image, first.image, before, after);
  expect(mutated.changedPixels, `${kind} definition uses identical capture pixels`).toBe(0);
  expect(mutated.stateMatches, `${kind} definition exact paint inputs`).toBe(false);
  expect(mutated.matches, `${kind} definition rejected independently of pixels`).toBe(false);
}

async function proveReferenceDefinitions(page: Page, first: Capture): Promise<void> {
  for (const kind of ["absolute CSS", "relative CSS", "absolute href", "relative href"] as const) {
    await proveReferenceDefinition(page, first, kind);
  }
}

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

async function proveOverviewComparisons(page: Page, first: Capture): Promise<void> {
  await proveIdentityRenames(page, first);
  await proveVisibleMutation(page, first);
  await proveHiddenPaintInputs(page, first);
  await proveReferenceDefinitions(page, first);
  await proveExternalReferences(page, first);
}

async function proveSignedOutCapture(page: Page, job: RunJob, capturer: Capturer): Promise<void> {
  const { gateway } = job;
  const { assertCapture, capture, snapshot } = capturer;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Operator token")).toBeVisible();
  const signInCapture = await capture("sign-in");
  await assertCapture("sign-in", "repeated", signInCapture, await snapshot());
  await signIn(page, gateway.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await page.goto(gateway.url);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
}

async function proveLeaseScenarios(page: Page, job: RunJob, capturer: Capturer): Promise<void> {
  const { gateway } = job;
  const { assertCapture, capture, snapshot } = capturer;
  for (const [scenario, expected] of [
    ["empty", "No leases."],
    ["long", "x".repeat(256)],
    ["refused", "Fixture route refused"],
  ] as const) {
    await renderScenario(page, scenario);
    await page.goto(new URL("/leases", gateway.url).href);
    if (scenario === "long")
      await expect(page.locator(`main tbody a[title="${expected}"]`)).toBeVisible();
    else await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await expect(page.locator(".connection [role=status]")).toHaveText("Connected");
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    const scenarioCapture = await capture(`leases-${scenario}`);
    await assertCapture(`leases-${scenario}`, "repeated", scenarioCapture, await snapshot());
  }
}

async function proveLiveStream(page: Page, job: RunJob): Promise<void> {
  const { gateway } = job;
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

async function proveCaseExtras(page: Page, job: RunJob, capturer: Capturer): Promise<void> {
  const { entry, viewport } = job;
  const wide = viewport.width === 1440;
  if (entry.name === "not-found" && wide) await proveSignedOutCapture(page, job, capturer);
  if (entry.name === "5-leases" && wide) await proveLeaseScenarios(page, job, capturer);
  if (entry.name === "8-activity" && wide) await proveLiveStream(page, job);
}

async function proveOverviewCapture(page: Page, job: RunJob, first: Capture): Promise<void> {
  if (job.entry.name !== "1-overview" || job.run !== "first") return;
  if (job.viewport.width === 1280) await proveSelfComparison(first);
  if (job.viewport.width === 1440) await proveOverviewComparisons(page, first);
}

export async function captureRun(job: RunJob): Promise<void> {
  const { entry, run, testInfo, viewport } = job;
  const page = await job.context.newPage();
  const capturer = createCapturer(page, job);
  await openCase(page, job);
  const suffix = viewport.width === 1440 ? "" : `-${viewport.width}x${viewport.height}`;
  await expect(page.locator("input:focus, textarea:focus, [contenteditable]:focus")).toHaveCount(0);
  // why: Playwright's caret hiding repaints unfocused input borders differently on alternating captures.
  const first = await capturer.capture(`${entry.name}${suffix}`);
  await proveOverviewCapture(page, job, first);
  const second = await capturer.snapshot();
  await capturer.assertCapture(`${entry.name}${suffix}`, "repeated", first, second);
  if (run === "first")
    await testInfo.attach(entry.name, {
      path: `${DIRECTORY}/${entry.name}${suffix}.png`,
      contentType: "image/png",
    });
  await proveCaseExtras(page, job, capturer);
}
