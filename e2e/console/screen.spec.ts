import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, type RunningDaemon, signIn, startDaemon, test } from "./fixtures.js";
import { captureLog, writeCaptureProgram } from "./screen-capture.js";

// why: the capture program this lane writes is its witness as well as its picture source -- it records
// when the daemon started it and when it went away. That is what lets these tests say a viewer opening
// a pane *started a capture on the worker* and that the same viewer leaving stopped one, which is the
// one promise this surface makes and a screenshot cannot prove.

const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };
const LEASE = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"] as const;

interface StreamingHost {
  readonly command: string;
  readonly dir: string;
  readonly host: RunningDaemon;
  readonly lease: string;
}

async function streamingHost(): Promise<StreamingHost> {
  const dir = await mkdtemp(join(tmpdir(), "simlock-screen-"));
  const command = await writeCaptureProgram(dir);
  let host: RunningDaemon | undefined;
  try {
    host = await startDaemon("worker", {
      config: {
        capabilities: { stream: { enabled: true, fps: 5 } },
      },
      driverScript: { ios: { ...IOS, screenCaptureCommand: command } },
    });
    const granted = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
    expect(granted.code, granted.stderr).toBe(0);
    return {
      command,
      dir,
      host,
      lease: (granted.json as { lease: { id: string } }).lease.id,
    };
  } catch (error) {
    await rm(dir, { force: true, recursive: true });
    await host?.dispose();
    throw error;
  }
}

async function cleanup(started: StreamingHost): Promise<void> {
  await started.host.dispose();
  await rm(started.dir, { force: true, recursive: true });
}

async function openLeasePage(page: Page, host: RunningDaemon, lease: string): Promise<void> {
  await page.goto(new URL(`/leases/${encodeURIComponent(lease)}`, host.url).toString());
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 3, name: "Screen" })).toBeVisible();
}

function showButton(page: Page) {
  return page.getByRole("button", { name: /^(Show screen|Stop)$/ });
}

function screen(page: Page) {
  return page.getByLabel("The leased device's screen");
}

// why: the mean colour of what the canvas holds, so "the picture changed" is a number rather than a
// hope -- three solid colours that alternate mean three distinct readings, and two equal ones mean a
// canvas painted once and left alone.
async function averageColour(page: Page): Promise<string> {
  const rgb = await screen(page).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const image = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height);
    if (image === undefined) throw new Error("the screen canvas has no 2d context");
    const data = image.data;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      red += data[i] ?? 0;
      green += data[i + 1] ?? 0;
      blue += data[i + 2] ?? 0;
    }
    const count = data.length / 4;
    return [red, green, blue].map((total) => Math.round(total / count));
  });
  return rgb.join(",");
}

async function fact(page: Page, label: string): Promise<string> {
  return page
    .getByRole("region", { exact: true, name: "Screen" })
    .locator(".facts > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
    .getByRole("definition")
    .innerText();
}

async function frames(page: Page): Promise<number> {
  const shown = await fact(page, "Frames");
  const parsed = Number.parseInt(shown, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function streamCapability(host: RunningDaemon): Promise<string | undefined> {
  const listed = await host.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  const views = (listed.json as { workers: { capabilities?: { name: string; state: string }[] }[] })
    .workers;
  return views[0]?.capabilities?.find((entry) => entry.name === "stream")?.state;
}

async function captureLogLines(dir: string, word: string): Promise<number> {
  const log = await captureLog(dir);
  return log.split("\n").filter((line) => line.startsWith(word)).length;
}

test.describe("the Screen pane", () => {
  test("shows nothing and starts no capture until asked", async ({ page }) => {
    const started = await streamingHost();
    try {
      await openLeasePage(page, started.host, started.lease);
      await expect(screen(page)).toHaveCount(0);
      await expect(page.getByText("No picture while this is off.")).toBeVisible();
      await expect.poll(() => fact(page, "Picture")).toBe("—");
      await expect.poll(() => fact(page, "State")).toBe("off");
      expect(await captureLogLines(started.dir, "opened")).toBe(0);
      expect(await streamCapability(started.host)).toBe("available");
    } finally {
      await cleanup(started);
    }
  });

  test("Show screen starts the capture, paints it, and reports what it is showing", async ({
    page,
  }) => {
    const started = await streamingHost();
    try {
      await openLeasePage(page, started.host, started.lease);
      await showButton(page).click();
      await expect(screen(page)).toBeVisible();
      await logReached(started.dir, "opened", 1);

      // why: these numbers are the capture program's own, so the pane sizing itself from them proves it
      // read the meta frame rather than guessing a size from whatever arrived first.
      await expect.poll(() => fact(page, "Picture"), { timeout: 10_000 }).toBe("120 × 240 mjpeg");
      await expect.poll(async () => (await frames(page)) > 0, { timeout: 10_000 }).toBe(true);
      await expect.poll(() => fact(page, "State"), { timeout: 10_000 }).toBe("live");

      // why: three different colours arrive in turn, so readings that keep differing prove frames are
      // still arriving rather than one picture painted once and left on the canvas.
      const seen = new Set<string>();
      await expect
        .poll(
          async () => {
            seen.add(await averageColour(page));
            return seen.size;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup(started);
    }
  });

  test("Stop stops the capture, and so does leaving the page", async ({ page }) => {
    const started = await streamingHost();
    try {
      await openLeasePage(page, started.host, started.lease);
      await showButton(page).click();
      await logReached(started.dir, "opened", 1);
      await expect.poll(async () => (await frames(page)) > 0, { timeout: 10_000 }).toBe(true);

      await showButton(page).click();
      await logReached(started.dir, "closed", 1);
      await expect(screen(page)).toHaveCount(0);
      await expect(showButton(page)).toHaveText("Show screen");

      await showButton(page).click();
      await logReached(started.dir, "opened", 2);
      await page.goto(new URL("/leases", started.host.url).toString());
      await logReached(started.dir, "closed", 2);

      // why: arriving back at the lease page must not resume a picture nobody asked for -- a third
      // "opened" here is a capture running for a viewer that only opened a page.
      await page.goto(
        new URL(`/leases/${encodeURIComponent(started.lease)}`, started.host.url).toString(),
      );
      await expect(showButton(page)).toHaveText("Show screen");
      expect(await captureLogLines(started.dir, "opened")).toBe(2);
    } finally {
      await cleanup(started);
    }
  });

  test("a worker with streaming off disables Show screen and says why before any click", async ({
    page,
  }) => {
    const dir = await mkdtemp(join(tmpdir(), "simlock-screen-"));
    let host: RunningDaemon | undefined;
    try {
      host = await startDaemon("worker", { driverScript: { ios: IOS } });
      const granted = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
      expect(granted.code, granted.stderr).toBe(0);
      const lease = (granted.json as { lease: { id: string } }).lease.id;
      await openLeasePage(page, host, lease);
      await expect(showButton(page)).toBeDisabled();
      await expect(page.getByText(/^Streaming is off on /)).toBeVisible();
      expect(await streamCapability(host)).toBe("off");
      await expect(screen(page)).toHaveCount(0);
      expect(await captureLog(dir)).toBe("");
    } finally {
      await host?.dispose();
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a release takes the pane away and leaves no capture running", async ({ page }) => {
    const started = await streamingHost();
    try {
      await openLeasePage(page, started.host, started.lease);
      await showButton(page).click();
      await logReached(started.dir, "opened", 1);
      await expect.poll(async () => (await frames(page)) > 0, { timeout: 10_000 }).toBe(true);

      const released = await started.host.cli(["release", started.lease]);
      expect(released.code, released.stderr).toBe(0);

      // why: a lease that is gone has no page to watch, so the pane goes with it and its abort stops the
      // capture. What this proves is the promise an operator can see: leaving a lease behind never
      // leaves a device being filmed. The guarantee that a lease ending stops a capture whose viewer is
      // still connected is not observable from a browser -- it is pinned in
      // `src/stream/captures.test.ts`, where a capture can be held open past the lease.
      await logReached(started.dir, "closed", 1);
      await expect(page.getByText("Lease not found.")).toBeVisible();
      expect(await captureLogLines(started.dir, "opened")).toBe(1);
    } finally {
      await cleanup(started);
    }
  });
});

async function logReached(dir: string, word: string, count: number): Promise<void> {
  // why: a capture stopping is the daemon's act, not the browser's, and it is the fact under test -- so
  // a lane that did not wait for it would pass with a capture that never started or never stopped.
  await expect
    .poll(async () => (await captureLogLines(dir, word)) >= count, { timeout: 10_000 })
    .toBe(true);
}
