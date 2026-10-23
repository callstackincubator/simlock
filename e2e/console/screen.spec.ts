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

async function openDevice(page: Page, target: Target, search = "?tab=devices"): Promise<void> {
  const path = `/fleet/${encodeURIComponent(target.workerId)}/${encodeURIComponent(target.deviceId)}${search}`;
  await page.goto(new URL(path, target.origin).toString());
  await signIn(page, target.token);
  await expect(page.getByRole("dialog")).toBeVisible();
}

function drawer(page: Page) {
  return page.getByRole("dialog");
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
      fleet = await startFleet([
        {
          config: { capabilities: { stream: { enabled: true, fps: 5 } } },
          driverScript: { ios: { ...IOS, screenCaptureCommand: gatewayCommand } },
          label: "worker-a",
        },
      ]);
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

async function logReached(dir: string, word: string, count: number): Promise<void> {
  // why: a capture stopping is the daemon's act, not the browser's, and it is the fact under test -- so
  // a lane that did not wait for it would pass with a capture that never started or never stopped.
  await expect
    .poll(async () => (await captureLogLines(dir, word)) >= count, { timeout: 10_000 })
    .toBe(true);
}
