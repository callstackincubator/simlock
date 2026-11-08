import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import type { FakeDriverScript } from "../fake-driver/types.js";

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

// why: a lease then a release deletes that device and the pool makes a warm one nobody holds, which is the device a viewer
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
      const { devices } = listed.json as { devices: { id: string; state: string }[] };
      ready = devices.find((device) => device.state === "ready")?.id ?? "";
      return ready;
    })
    .not.toBe("");
  return ready;
}

// why: a released device is deleted, so the one way to reach a shut-down device without a lease is the pool's: the daemon stops
// (its idle devices shut down), and the restarted one cannot boot the device back because the driver's boots fail.
async function shutdownDevice(host: RunningDaemon, script: FakeDriverScript): Promise<string> {
  let ready = "";
  await expect
    .poll(async () => {
      const listed = await host.cli(["status", "--json"]);
      const { devices } = listed.json as { devices: { id: string; state: string }[] };
      ready = devices.find((device) => device.state === "ready")?.id ?? "";
      return ready;
    })
    .not.toBe("");
  await host.stop();
  await host.writeDriverScript({
    ios: { ...script.ios, failures: { makeReady: { message: "no boot", type: "generic" } } },
  });
  await host.start();
  await expect
    .poll(async () => {
      const listed = await host.cli(["status", "--json"]);
      const { devices } = listed.json as { devices: { id: string; state: string }[] };
      return devices.find((device) => device.id === ready)?.state;
    })
    .toBe("shutdown");
  await host.writeDriverScript(script);
  return ready;
}

async function openDevice(page: Page, target: Target, search = "?tab=devices"): Promise<void> {
  const path = `/fleet/${encodeURIComponent(target.workerId)}/${encodeURIComponent(target.deviceId)}${search}`;
  await page.goto(new URL(path, target.origin).toString());
  await signIn(page, target.token);
  await expect(page.getByRole("dialog")).toBeVisible();
}

function streamUrl(target: Target): string {
  return new URL(
    `/fleet/${encodeURIComponent(target.workerId)}/devices/${encodeURIComponent(target.deviceId)}/`,
    target.origin,
  ).toString();
}

// why: the streaming page is a page of its own, addressed by worker and device, so a test opens it
// directly the way a bookmark or a reload does.
async function openStream(page: Page, target: Target, signedIn = false): Promise<void> {
  await page.goto(streamUrl(target));
  if (!signedIn) await signIn(page, target.token);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("/");
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

test.describe("the device's streaming page", () => {
  test("opens from the drawer's Watch link with no capture before it, paints a picture and owns one capture until Stop watching, leaving or reloading, with the holder only when leased and no input socket", async ({
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
        const sockets: string[] = [];
        page.on("websocket", (socket) => sockets.push(socket.url()));

        await openDevice(page, target);
        await expect(screen(page)).toHaveCount(0);
        expect(await captureLogLines(dir, "opened")).toBe(0);

        await drawer(page).getByRole("link", { name: "Watch" }).click();
        await expect(page).toHaveURL(
          new RegExp(
            `/fleet/${encodeURIComponent(workerId)}/devices/${encodeURIComponent(watched)}/$`,
          ),
        );
        await expect(page.getByRole("heading", { level: 1 })).toContainText("iPhone 16");
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

        // why: the two pills over the picture carry the stream's own figures, not a mock's.
        await expect(page.locator(".screen-pills")).toContainText(/LIVE · \d+ fps/, {
          timeout: 10_000,
        });
        await expect(page.locator(".screen-pills")).toContainText(/mjpeg · 120×240 · \d/);
        await expect(page.getByRole("region", { name: "Holder" })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Device" })).toBeVisible();

        const leased = await host.cli([...LEASE, "--agent-id", "console-screen", "--detach"]);
        expect(leased.code, leased.stderr).toBe(0);
        const holder = page.getByRole("region", { name: "Holder" });
        await expect(holder).toContainText("console-screen");
        await expect(holder.getByRole("link", { name: "Lease details" })).toBeVisible();
        await expect(holder.getByRole("button", { name: "Copy lease id" })).toBeVisible();
        await expect(holder.getByRole("button", { name: "Release" })).toBeVisible();
        await page.waitForTimeout(500);
        expect(await captureLogLines(dir, "opened")).toBe(1);
        expect(await captureLogLines(dir, "closed")).toBe(0);

        await page.getByRole("button", { name: "Stop watching" }).click();
        await logReached(dir, "closed", 1);
        await expect(page).toHaveURL(new RegExp(`/fleet/${encodeURIComponent(workerId)}$`));
        await expect(screen(page)).toHaveCount(0);

        // why: a reload of the address is a new page and so a new capture, the one the old closed.
        await openStream(page, target, true);
        await logReached(dir, "opened", 2);
        await page.reload();
        await logReached(dir, "opened", 3);
        await expect(screen(page)).toBeVisible();
        await page.goBack();
        await logReached(dir, "closed", 3);
        expect(sockets).toEqual([]);
        page.removeAllListeners("websocket");
        await host.cli(["release", "--all", "--yes"]);
      }
    } finally {
      if (fleet !== undefined) await disposeFleet(fleet);
      await rm(fleetDir, { force: true, recursive: true });
      await cleanup(started);
    }
  });

  test("redirects a legacy ?drawer=screen address to the page without opening a capture from the drawer", async ({
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
      await page.goto(
        new URL(
          `/fleet/${encodeURIComponent(target.workerId)}/${encodeURIComponent(target.deviceId)}?tab=devices&drawer=screen`,
          target.origin,
        ).toString(),
      );
      await signIn(page, target.token);
      await expect(page).toHaveURL(new RegExp(`/devices/${encodeURIComponent(target.deviceId)}/$`));
      await expect(screen(page)).toBeVisible();
      await logReached(started.dir, "opened", 1);
      await expect(drawer(page)).toHaveCount(0);
    } finally {
      await cleanup(started);
    }
  });
});

const SHUT_DOWN = "The device is shut down. Its screen shows while it runs.";

test.describe("the streaming page of a device that is not running", () => {
  test("says why instead of starting a capture, starts the picture when the device runs, closes it when the lease ends, shows the daemon's words for a refused stream, and says streaming is off where it is", async ({
    page,
  }) => {
    const started = await streamingHost({
      warmPool: { targets: [{ count: 1, model: "iPhone 16", osVersion: "18.4", platform: "ios" }] },
    });
    const off = await startDaemon("worker", {
      config: { warmPool: { enabled: false } },
      driverScript: { ios: IOS },
    });
    try {
      const host = started.host;
      const workerId = await workerIdOn(host);
      const deviceId = await shutdownDevice(host, {
        ios: { ...IOS, screenCaptureCommand: started.command },
      });
      const streams: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/v1/stream/")) streams.push(request.url());
      });

      await openStream(page, { deviceId, origin: host.url, token: host.tokens.operator, workerId });
      await expect(page.getByText(SHUT_DOWN)).toBeVisible();
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
      await openStream(page, target, true);
      await expect(page.getByText("The row is behind: the device stopped just now.")).toBeVisible();
      await expect(screen(page)).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await page.unroute("**/v1/stream/**");
      await refuse(500, "CAPTURE_FAILED", "The capture program could not start.");
      await openStream(page, target, true);
      await expect(page.getByRole("alert")).toHaveText("The capture program could not start.");
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
      await openStream(page, {
        deviceId: silent,
        origin: off.url,
        token: off.tokens.operator,
        workerId: await workerIdOn(off),
      });
      await expect(page.getByText(/^Streaming is off on /)).toBeVisible();
      expect(quiet).toEqual([]);
    } finally {
      await off.dispose();
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
