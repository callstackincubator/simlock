import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

import { test, expect, type Page } from "@playwright/test";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = request.url?.startsWith("/assets/") ? request.url : "/index.html";
      const file = resolve("dist/ui", `.${path}`);
      const content = await readFile(file);
      response.setHeader(
        "Content-Type",
        (
          { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" } as Record<
            string,
            string
          >
        )[extname(file)] ?? "application/octet-stream",
      );
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
});

async function fixture(page: Page) {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.addInitScript(() => {
    sessionStorage.setItem("simlock.operatorToken", "synthetic-test-token");
    const original = window.fetch;
    const active = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const counts = { opened: 0, closed: 0, max: 0, duplicates: 0 };
    let mode = sessionStorage.getItem("wallTest.mode") ?? "running";
    let workerIds = ["synthetic"];
    let holdCancel: string | undefined;
    let finishCancel: (() => void) | undefined;
    let devices = ["one", "two", "three", "four"];
    const encoder = new TextEncoder();
    const packet = (tag: number, bytes: Uint8Array) => {
      const frame = new Uint8Array(bytes.length + 5);
      new DataView(frame.buffer).setUint32(0, bytes.length + 1);
      frame[4] = tag;
      frame.set(bytes, 5);
      return frame;
    };
    const workers = () => ({
      workers: workerIds.map((id) => ({
        id,
        label: "Synthetic worker",
        connection: mode === "disconnected" ? "disconnected" : "connected",
        drained: false,
        lastSeenAt: 0,
        capabilities: mode === "disabled" ? [] : [{ name: "stream", state: "available" }],
        leases:
          mode === "empty" || !devices.includes("one")
            ? []
            : [
                {
                  id: "lse_one",
                  deviceId: "one",
                  requesterId: "claude-code:alpha",
                  ownerId: "claude-code:alpha",
                  grantedAt: Date.now() - 90_000,
                  ttlMs: 600_000,
                  ttlDeadline: Date.now() + 600_000,
                  lastRenewedAt: Date.now(),
                  idChosenByRequester: false,
                },
              ],
        devices: (mode === "empty" ? [] : devices).map((id, index) => ({
          id,
          state: index === 0 ? "leased" : "ready",
          physical: false,
          spec: {
            platform: index === 3 ? "android" : "ios",
            model: index === 3 ? "Pixel 9" : "iPhone 16",
            osVersion: index === 3 ? "35" : "18.4",
          },
        })),
      })),
    });
    let events: ReadableStreamDefaultController<Uint8Array>;
    const controls = {
      active: () => [...active.keys()],
      counts,
      hidden(value: boolean) {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: value ? "hidden" : "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      },
      fail(id: string) {
        active.get(id)?.error(new Error("Synthetic capture failed"));
        active.delete(id);
        counts.closed++;
      },
      end(id: string) {
        active.get(id)?.enqueue(packet(7, encoder.encode(JSON.stringify({ reason: "explicit" }))));
      },
      add(notify: boolean) {
        devices.push("five");
        if (notify)
          events.enqueue(
            encoder.encode(
              `event: device.ready\ndata: ${JSON.stringify({ id: "evt_five", seq: 1, timestamp: Date.now(), event: "device.ready", payload: { deviceId: "five" } })}\n\n`,
            ),
          );
      },
      remove() {
        devices = ["one"];
        events.enqueue(encoder.encode("event: device.deleted\ndata: {}\n\n"));
      },
      mode(value: string) {
        mode = value;
        sessionStorage.setItem("wallTest.mode", value);
        events.enqueue(encoder.encode("event: device.changed\ndata: {}\n\n"));
      },
      holdCancel(id: string) {
        holdCancel = id;
      },
      finishCancel() {
        holdCancel = undefined;
        finishCancel?.();
      },
      duplicateWorkers() {
        workerIds = ["synthetic", "other"];
        devices = ["one"];
        mode = "disabled";
        events.enqueue(encoder.encode("event: device.changed\ndata: {}\n\n"));
      },
      unauthorized: false,
    };
    Object.assign(window, { wallTest: controls });
    async function capture(id: string, signal: AbortSignal | null | undefined) {
      counts.opened++;
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = 390;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#192c3b";
      ctx.fillRect(0, 0, 180, 390);
      ctx.fillStyle = "#ffffff";
      ctx.font = "16px sans-serif";
      ctx.fillText("Synthetic fixture", 20, 120);
      ctx.fillText(id, 20, 155);
      const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), "image/jpeg"));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        active.delete(id);
        counts.closed++;
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            if (active.has(id)) counts.duplicates++;
            active.set(id, c);
            counts.max = Math.max(counts.max, active.size);
            c.enqueue(
              packet(
                5,
                encoder.encode(JSON.stringify({ codec: "mjpeg", width: 180, height: 390, fps: 5 })),
              ),
            );
            if (mode !== "connecting") c.enqueue(packet(3, jpeg));
            if (signal?.aborted) {
              close();
              c.close();
            } else
              signal?.addEventListener(
                "abort",
                () => {
                  close();
                  try {
                    c.close();
                  } catch {}
                },
                { once: true },
              );
          },
          cancel: () => {
            if (holdCancel !== id) {
              close();
              return undefined;
            }
            return new Promise<void>((resolve) => {
              finishCancel = () => {
                close();
                resolve();
              };
            });
          },
        }),
        { headers: { "Content-Type": "application/octet-stream" } },
      );
    }
    // fallow-ignore-next-line complexity -- the fake daemon's router: one branch per route it answers.
    window.fetch = async (input, init) => {
      const path = String(input);

      if (!path.startsWith("/v1/")) return original(input, init);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (
        path === "/v1/identity" &&
        !controls.unauthorized &&
        new Headers(init?.headers).has("Authorization")
      )
        return json({ name: "Synthetic operator", via: "token" });
      if (path === "/v1/identity")
        return json({ error: { code: "UNAUTHORIZED", message: "Synthetic signed out" } }, 401);
      if (controls.unauthorized)
        return json({ error: { code: "UNAUTHORIZED", message: "Synthetic signed out" } }, 401);
      if (path === "/v1/events/stream")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              events = c;
              c.enqueue(encoder.encode(": connected\n\n"));
              init?.signal?.addEventListener("abort", () => c.close(), { once: true });
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      const answers: Readonly<Record<string, unknown>> = {
        "/v1/healthz": { ok: true },
        "/v1/workers": workers(),
        "/v1/inbox": { items: [], now: Date.now() },
        "/v1/status": { daemon: { mode: "worker", version: "0.5.0" } },
      };
      if (Object.hasOwn(answers, path)) return json(answers[path]);
      if (path.startsWith("/v1/stream/")) {
        if (mode === "unsupported")
          return json(
            { error: { code: "STREAM_NOT_SUPPORTED", message: "Synthetic unsupported" } },
            415,
          );
        return capture(path.split("/").at(-1)!, init?.signal);
      }
      return json({});
    };
  });
}

type Controls = {
  active(): string[];
  counts: { opened: number; closed: number; max: number; duplicates: number };
  mode(value: string): void;
  hidden(value: boolean): void;
  fail(id: string): void;
  end(id: string): void;
  add(notify: boolean): void;
  remove(): void;
  holdCancel(id: string): void;
  finishCancel(): void;
  duplicateWorkers(): void;
  unauthorized: boolean;
};
async function active(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { wallTest: Controls }).wallTest.active().sort(),
  );
}

const ALL = ["one", "two", "three", "four"];

function watching(ids: readonly string[], worker = "synthetic") {
  const params = new URLSearchParams();
  for (const id of ids) params.append("watch", JSON.stringify([worker, id]));
  return `${origin}/screens?${params}`;
}

async function showAll(page: Page) {
  await page.getByRole("radio", { name: "All" }).check({ force: true });
}

async function duplicates(page: Page) {
  return page.evaluate(
    () => (window as unknown as { wallTest: Controls }).wallTest.counts.duplicates,
  );
}

test("lists running devices with their holders, streams only the ones watched, at most four", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.clock.install();
  await page.goto(`${origin}/screens`);
  await expect(page.getByRole("heading", { name: "Screens", exact: true })).toBeVisible();
  await expect(page.getByText(/Choose Watch on a running device below/)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText("claude-code:alpha");
  await expect(page.locator("tbody tr").first()).toContainText(/1 min \d+ s/);
  expect(await active(page)).toEqual([]);
  await showAll(page);
  await expect(page.locator("tbody tr")).toHaveCount(4);
  for (const id of ALL)
    await page.getByRole("button", { name: new RegExp(`^Watch .*\\(${id}\\)$`) }).click();
  await expect.poll(() => active(page)).toEqual(["four", "one", "three", "two"]);
  await expect(page.locator("canvas")).toHaveCount(4);
  await expect(
    page.getByRole("article", {
      name: "Screen: claude-code:alpha, iPhone 16 on Synthetic worker (one)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "Open streaming page: Pixel 9, Pixel 9 on Synthetic worker (four)",
      exact: true,
    }),
  ).toHaveAttribute("href", "/fleet/synthetic/devices/four/");
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.add(true));
  await page.clock.runFor(350);
  await expect(page.getByRole("button", { name: /^Watch .*\(five\)$/ })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("screens-desktop.png"), fullPage: true });

  await page.reload();
  await expect.poll(() => active(page)).toEqual(["four", "one", "three", "two"]);
  await page.getByRole("link", { name: "Screens", exact: true }).click();
  await expect(page).toHaveURL(/watch=/);
  await expect(page.locator(".screens-slot")).toHaveCount(4);
  await expect.poll(() => active(page)).toEqual(["four", "one", "three", "two"]);
  await page
    .getByRole("button", { name: /^Stop watching .*\(two\)$/ })
    .first()
    .click();
  await expect.poll(() => active(page)).toEqual(["four", "one", "three"]);
  await expect(page.locator(".screens-slot")).toHaveCount(3);

  await page.setViewportSize({ width: 360, height: 800 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("screens-narrow.png"), fullPage: true });
  expect(await duplicates(page)).toBe(0);
});

test("a hidden tab, removal, navigation and authentication loss close watched captures; failures stay isolated", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(watching(ALL));
  await expect.poll(() => active(page)).toHaveLength(4);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.hidden(true));
  await expect.poll(() => active(page)).toEqual([]);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByText("Paused while this tab is hidden.", { exact: true })).toHaveCount(4);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.hidden(false));
  await expect.poll(() => active(page)).toHaveLength(4);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.fail("two"));
  await expect(page.getByText("Synthetic capture failed", { exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toHaveLength(3);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.end("three"));
  await expect(page.getByText("The lease was released.", { exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.remove());
  await expect(page.locator(".screens-slot")).toHaveCount(1);
  await expect.poll(() => active(page)).toEqual(["one"]);
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect.poll(() => active(page)).toEqual([]);
  await page.getByRole("link", { name: "Screens", exact: true }).click();
  await expect.poll(() => active(page)).toEqual(["one"]);
  expect(await duplicates(page)).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.counts.max),
  ).toBe(4);
  await page.evaluate(() => {
    const c = (window as unknown as { wallTest: Controls }).wallTest;
    c.unauthorized = true;
    c.remove();
  });
  await expect.poll(() => active(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("a watched device whose stream cannot start says why in its place", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(watching(ALL));
  await expect.poll(() => active(page)).toHaveLength(4);
  for (const [mode, text] of [
    ["disabled", "Streaming is off on Synthetic worker."],
    ["disconnected", "Synthetic worker is disconnected."],
    ["unsupported", "This device cannot be streamed."],
  ] as const) {
    await page.evaluate(
      (value) => (window as unknown as { wallTest: Controls }).wallTest.mode(value),
      mode,
    );
    await expect(page.getByText(text, { exact: true })).toHaveCount(4);
    await expect.poll(() => active(page)).toEqual([]);
    await expect(page.locator("canvas")).toHaveCount(0);
  }
  await page.evaluate(() =>
    (window as unknown as { wallTest: Controls }).wallTest.mode("connecting"),
  );
  await page.reload();
  await expect(page.getByText("Waiting for the first frame.", { exact: true })).toHaveCount(4);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.mode("empty"));
  await expect(page.getByText("No leased devices.", { exact: true })).toBeVisible();
  await expect(page.locator(".screens-slot")).toHaveCount(0);
  await expect.poll(() => active(page)).toEqual([]);
});

test("signing out closes every watched capture", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(watching(ALL));
  await expect.poll(() => active(page)).toHaveLength(4);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toEqual([]);
  expect(
    await page.evaluate(() => {
      const { opened, closed } = (window as unknown as { wallTest: Controls }).wallTest.counts;
      return opened - closed;
    }),
  ).toBe(0);
});

test("lists a new running device without a reload after an event, a poll, or returning to the tab", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.clock.install();
  for (const source of ["event", "poll", "visible"] as const) {
    await page.goto(`${origin}/screens`);
    await showAll(page);
    await expect(page.locator("tbody tr")).toHaveCount(4);
    if (source === "visible")
      await page.evaluate(() =>
        (window as unknown as { wallTest: Controls }).wallTest.hidden(true),
      );
    await page.evaluate(
      (notify) => (window as unknown as { wallTest: Controls }).wallTest.add(notify),
      source === "event",
    );
    if (source === "event") await page.clock.runFor(350);
    if (source === "poll") await page.clock.runFor(15_001);
    if (source === "visible")
      await page.evaluate(() =>
        (window as unknown as { wallTest: Controls }).wallTest.hidden(false),
      );
    await expect(page.locator("tbody tr")).toHaveCount(5);
    await expect(page.getByRole("button", { name: /^Watch .*\(five\)$/ })).toBeEnabled();
    expect(await active(page)).toEqual([]);
  }
});

test("a newly watched screen waits until a stopped one has finished closing", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.clock.install();
  for (const outcome of ["start", "hidden", "navigation", "logout"] as const) {
    await page.goto(watching(ALL));
    await expect.poll(() => active(page)).toHaveLength(4);
    await page.evaluate(() => {
      const controls = (window as unknown as { wallTest: Controls }).wallTest;
      controls.add(true);
      controls.holdCancel("one");
    });
    await page.clock.runFor(350);
    await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.end("one"));
    await expect(page.getByText("The lease was released.", { exact: true })).toBeVisible();
    await showAll(page);
    await page
      .getByRole("button", { name: /^Stop watching .*\(one\)$/ })
      .first()
      .click();
    await page.getByRole("button", { name: /^Watch .*\(five\)$/ }).click();
    await expect(
      page.getByText("Starting once another screen has closed.", { exact: true }),
    ).toBeVisible();
    await page.clock.runFor(15_001);
    expect(await active(page)).toEqual(["four", "three", "two"]);
    if (outcome === "hidden")
      await page.evaluate(() =>
        (window as unknown as { wallTest: Controls }).wallTest.hidden(true),
      );
    if (outcome === "navigation")
      await page.getByRole("link", { name: "Fleet", exact: true }).click();
    if (outcome === "logout")
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.evaluate(() =>
      (window as unknown as { wallTest: Controls }).wallTest.finishCancel(),
    );
    if (outcome === "start")
      await expect.poll(() => active(page)).toEqual(["five", "four", "three", "two"]);
    else {
      await expect.poll(() => active(page)).toEqual([]);
      await page.clock.runFor(15_001);
      expect(await active(page)).toEqual([]);
    }
    expect(await duplicates(page)).toBe(0);
    if (outcome === "hidden")
      await page.evaluate(() =>
        (window as unknown as { wallTest: Controls }).wallTest.hidden(false),
      );
  }
});
