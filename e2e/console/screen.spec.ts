import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";
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
}

async function streamingHost(
  extraConfig: Readonly<Record<string, unknown>> = {},
): Promise<StreamingHost> {
  const dir = await mkdtemp(join(tmpdir(), "simlock-screen-"));
  const command = await writeCaptureProgram(dir);
  let host: RunningDaemon | undefined;
  try {
    host = await startDaemon("worker", {
      config: {
        capabilities: { stream: { enabled: true, fps: 5 } },
        ...extraConfig,
      },
      driverScript: { ios: { ...IOS, screenCaptureCommand: command } },
    });
    return { command, dir, host };
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

interface Target {
  readonly deviceId: string;
  readonly origin: string;
  readonly token: string;
  readonly workerId: string;
}

async function workerIdOn(reader: RunningDaemon): Promise<string> {
  const listed = await reader.cli(["worker", "list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  const [view] = (listed.json as { workers: { id: string }[] }).workers;
  return view?.id ?? "";
}

async function deviceIds(host: RunningDaemon): Promise<readonly string[]> {
  const result = await host.cli(["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return (result.json as { devices: { id: string }[] }).devices.map((device) => device.id);
}

// why: a lease then a release leaves one warm device that nobody holds, which is the device a viewer
// can watch without a lease.
async function warmDevice(host: RunningDaemon): Promise<string> {
  const granted = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  const released = await host.cli(["release", "--all", "--yes"]);
  expect(released.code, released.stderr).toBe(0);
  let ready = "";
  await expect
    .poll(async () => {
      const listed = await host.cli(["status", "--json"]);
      const [device] = (listed.json as { devices: { id: string; state: string }[] }).devices;
      ready = device?.state === "ready" ? device.id : "";
      return ready;
    })
    .not.toBe("");
  return ready;
}

// why: with the warm pool off a released device is left shut down, which is the one state a viewer
// can reach a device in without a lease changing under them.
async function shutdownDevice(host: RunningDaemon): Promise<string> {
  const granted = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
  expect(granted.code, granted.stderr).toBe(0);
  const released = await host.cli(["release", "--all", "--yes"]);
  expect(released.code, released.stderr).toBe(0);
  let id = "";
  await expect
    .poll(async () => {
      const listed = await host.cli(["status", "--json"]);
      const [device] = (listed.json as { devices: { id: string; state: string }[] }).devices;
      id = device?.state === "shutdown" ? device.id : "";
      return id;
    })
    .not.toBe("");
  return id;
}

async function openDevice(page: Page, target: Target, search = "?tab=devices"): Promise<void> {
  const path = `/fleet/${encodeURIComponent(target.workerId)}/${encodeURIComponent(target.deviceId)}${search}`;
  await page.goto(new URL(path, target.origin).toString());
  await signIn(page, target.token);
  await expect(page.getByRole("dialog")).toBeVisible();
}

// why: the page is already signed in on this origin, so the token form is not there to fill.
async function reopen(page: Page, target: Target): Promise<void> {
  const path = `/fleet/${encodeURIComponent(target.workerId)}/${encodeURIComponent(target.deviceId)}?tab=devices&drawer=screen`;
  await page.goto(new URL(path, target.origin).toString());
  await expect(page.getByRole("dialog")).toBeVisible();
}

// why: the stream numbers' popover is a dialog too, so the drawer is the one that holds the tabs.
function drawer(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("tablist") });
}

function screen(page: Page) {
  return page.getByLabel("The device's screen");
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

async function captureLogLines(dir: string, word: string): Promise<number> {
  const log = await captureLog(dir);
  return log.split("\n").filter((line) => line.startsWith(word)).length;
}

test.describe("the device drawer's Screen tab", () => {
  test("opens on Details with no capture, starts one and paints it on Screen, closes it on Details or closing the drawer, and keeps it when the device is leased", async ({
    page,
  }) => {
    const started = await streamingHost();
    const fleetDir = await mkdtemp(join(tmpdir(), "simlock-screen-"));
    let fleet: Awaited<ReturnType<typeof startFleet>> | undefined;
    try {
      const gatewayCommand = await writeCaptureProgram(fleetDir);
      fleet = await startFleet(
        [
          {
            config: { capabilities: { stream: { enabled: true, fps: 5 } } },
            driverScript: { ios: { ...IOS, screenCaptureCommand: gatewayCommand } },
            label: "worker-a",
          },
        ],
        { gatewayConfig: { capabilities: { stream: { enabled: true } } } },
      );
      const worker = fleet.workers[0];
      if (worker === undefined) throw new Error("the fleet has no worker");
      const cases = [
        { dir: started.dir, host: started.host, reader: started.host },
        { dir: fleetDir, host: worker, reader: fleet.gateway },
      ];
      for (const { dir, host, reader } of cases) {
        const workerId = await workerIdOn(reader);
        const watched = await warmDevice(host);
        const target = {
          deviceId: watched,
          origin: reader.url,
          token: reader.tokens.operator,
          workerId,
        };
        const streams: string[] = [];
        const track = (request: { url(): string }) => {
          if (request.url().includes("/v1/stream/")) streams.push(request.url());
        };
        page.on("requestfinished", track);
        page.on("requestfailed", track);

        await openDevice(page, target);
        await expect(drawer(page).getByRole("tab", { name: "Details" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(screen(page)).toHaveCount(0);
        expect(await captureLogLines(dir, "opened")).toBe(0);

        await drawer(page).getByRole("tab", { name: "Screen" }).click();
        await expect(page).toHaveURL(/[?&]drawer=screen(&|$)/);
        await expect(screen(page)).toBeVisible();
        await logReached(dir, "opened", 1);
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

        const leased = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
        expect(leased.code, leased.stderr).toBe(0);
        await page.waitForTimeout(500);
        expect(await captureLogLines(dir, "opened")).toBe(1);
        expect(await captureLogLines(dir, "closed")).toBe(0);
        expect(streams).toEqual([]);

        await drawer(page).getByRole("tab", { name: "Details" }).click();
        await logReached(dir, "closed", 1);
        await expect(screen(page)).toHaveCount(0);

        await drawer(page).getByRole("tab", { name: "Screen" }).click();
        await logReached(dir, "opened", 2);
        // why: Escape comes once the picture is up, so the test closes a capture that is streaming,
        // as the Details click above does, and not one still starting.
        await expect.poll(() => averageColour(page), { timeout: 10_000 }).not.toBe("0,0,0");
        await page.keyboard.press("Escape");
        await logReached(dir, "closed", 2);
        await expect(drawer(page)).toBeHidden();
        await expect(page).not.toHaveURL(/drawer=/);

        const second = await host.cli([...LEASE, "--agent-id", "console-screen-2", "--detach"]);
        expect(second.code, second.stderr).toBe(0);
        const other = (await deviceIds(host)).find((id) => id !== watched) ?? "";
        expect(other).not.toBe("");
        await page
          .getByRole("region", { name: "Devices", exact: true })
          .getByRole("row")
          .filter({ hasText: other })
          .getByRole("link")
          .first()
          .click();
        await expect(drawer(page).getByRole("tab", { name: "Details" })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await page.waitForTimeout(500);
        expect(await captureLogLines(dir, "opened")).toBe(2);
        page.off("requestfinished", track);
        page.off("requestfailed", track);
      }
    } finally {
      if (fleet !== undefined) await disposeFleet(fleet);
      await rm(fleetDir, { force: true, recursive: true });
      await cleanup(started);
    }
  });
});

const SHUT_DOWN = "The device is shut down. Its screen shows while it runs.";

test.describe("the Screen tab of a device that is not running", () => {
  test("says why instead of starting a capture, starts the picture when the device runs, shows the sentence again when it is shut down while watched, shows the daemon's words for a refused stream, and says streaming is off where it is", async ({
    page,
  }) => {
    const started = await streamingHost({ warmPool: { enabled: false } });
    const off = await startDaemon("worker", {
      config: { warmPool: { enabled: false } },
      driverScript: { ios: IOS },
    });
    try {
      const host = started.host;
      const workerId = await workerIdOn(host);
      const deviceId = await shutdownDevice(host);
      const streams: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/v1/stream/")) streams.push(request.url());
      });

      await openDevice(
        page,
        { deviceId, origin: host.url, token: host.tokens.operator, workerId },
        "?tab=devices&drawer=screen",
      );
      await expect(drawer(page).getByText(SHUT_DOWN)).toBeVisible();
      await expect(screen(page)).toHaveCount(0);
      expect(streams).toEqual([]);
      expect(await captureLogLines(started.dir, "opened")).toBe(0);

      const leased = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
      expect(leased.code, leased.stderr).toBe(0);
      await expect(screen(page)).toBeVisible();
      await logReached(started.dir, "opened", 1);

      const released = await host.cli(["release", "--all", "--yes"]);
      expect(released.code, released.stderr).toBe(0);
      await logReached(started.dir, "closed", 1);
      await expect(drawer(page).getByText(SHUT_DOWN)).toBeVisible();
      await expect(screen(page)).toHaveCount(0);
      expect(await captureLogLines(started.dir, "opened")).toBe(1);

      // why: the daemon's own words are the only thing a refused stream can tell the reader, so the
      // answers are scripted per request; a 409 on a row that says `leased` is the row being behind.
      const reasoned = await host.cli([...LEASE, "--agent-id", "console-screen-409", "--detach"]);
      expect(reasoned.code, reasoned.stderr).toBe(0);
      const refuse = (status: number, code: string, message: string) =>
        page.route("**/v1/stream/**", (route) =>
          route.fulfill({
            body: JSON.stringify({ error: { code, message } }),
            contentType: "application/json",
            status,
          }),
        );
      let held = "";
      await expect
        .poll(async () => {
          const listed = await host.cli(["status", "--json"]);
          const devices = (listed.json as { devices: { id: string; state: string }[] }).devices;
          held = devices.find((device) => device.state === "leased")?.id ?? "";
          return held;
        })
        .not.toBe("");
      const target = { deviceId: held, origin: host.url, token: host.tokens.operator, workerId };
      await refuse(409, "DEVICE_NOT_RUNNING", "The row is behind: the device stopped just now.");
      await reopen(page, target);
      await expect(
        drawer(page).getByText("The row is behind: the device stopped just now."),
      ).toBeVisible();
      await expect(screen(page)).toHaveCount(0);
      await expect(drawer(page).getByRole("alert")).toHaveCount(0);
      await page.unroute("**/v1/stream/**");
      await refuse(500, "CAPTURE_FAILED", "The capture program could not start.");
      await reopen(page, target);
      await expect(drawer(page).getByRole("alert")).toHaveText(
        "The capture program could not start.",
      );
      await page.unroute("**/v1/stream/**");

      // why: a leased device is one the daemon would stream, so only the worker's own setting can be
      // the reason no request is made.
      const heldOff = await off.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
      expect(heldOff.code, heldOff.stderr).toBe(0);
      const [silent = ""] = await deviceIds(off);
      expect(silent).not.toBe("");
      const quiet: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/v1/stream/")) quiet.push(request.url());
      });
      await openDevice(
        page,
        {
          deviceId: silent,
          origin: off.url,
          token: off.tokens.operator,
          workerId: await workerIdOn(off),
        },
        "?tab=devices&drawer=screen",
      );
      await expect(drawer(page).getByText(/^Streaming is off on /)).toBeVisible();
      expect(quiet).toEqual([]);
    } finally {
      await off.dispose();
      await cleanup(started);
    }
  });
});

test.describe("the stream numbers", () => {
  test("sit behind the Stream details button, in a popover that Escape or a second click closes while the drawer and its capture stay", async ({
    page,
  }) => {
    const started = await streamingHost();
    try {
      const host = started.host;
      const target = {
        deviceId: await warmDevice(host),
        origin: host.url,
        token: host.tokens.operator,
        workerId: await workerIdOn(host),
      };
      await openDevice(page, target, "?tab=devices&drawer=screen");
      await expect(screen(page)).toBeVisible();
      await logReached(started.dir, "opened", 1);

      const details = drawer(page).getByRole("button", { name: "Stream details" });
      const numbers = page.getByRole("dialog", { name: "Stream details" });
      await expect(drawer(page).getByText("Picture", { exact: true })).toHaveCount(0);
      await expect(numbers).toHaveCount(0);

      await details.click();
      await expect(numbers).toBeVisible();
      const labels = await numbers.locator(".facts dt").allTextContents();
      expect(labels).toEqual(["State", "Picture", "Frames", "Rate", "Bandwidth", "Dropped"]);
      await expect(drawer(page).getByText("Picture", { exact: true })).toHaveCount(0);
      const picture = numbers
        .locator(".facts > div")
        .filter({ has: page.getByText("Picture", { exact: true }) })
        .getByRole("definition");
      await expect(picture).toHaveText("120 × 240 mjpeg", { timeout: 10_000 });

      await page.keyboard.press("Escape");
      await expect(numbers).toHaveCount(0);
      await expect(drawer(page)).toBeVisible();

      await details.click();
      await expect(numbers).toBeVisible();
      await details.click();
      await expect(numbers).toHaveCount(0);
      await expect(drawer(page)).toBeVisible();
      await expect(screen(page)).toBeVisible();
      expect(await captureLogLines(started.dir, "closed")).toBe(0);
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
