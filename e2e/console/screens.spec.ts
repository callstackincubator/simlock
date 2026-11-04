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
    let mode = "running";
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
      workers: [
        {
          id: "synthetic",
          label: "Synthetic worker",
          connection: mode === "disconnected" ? "disconnected" : "connected",
          drained: false,
          lastSeenAt: 0,
          capabilities: mode === "disabled" ? [] : [{ name: "stream", state: "available" }],
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
        },
      ],
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
      remove() {
        devices = ["one"];
        events.enqueue(encoder.encode("event: device.deleted\ndata: {}\n\n"));
      },
      mode(value: string) {
        mode = value;
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
          cancel: close,
        }),
        { headers: { "Content-Type": "application/octet-stream" } },
      );
    }
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
  remove(): void;
  unauthorized: boolean;
};
async function active(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { wallTest: Controls }).wallTest.active().sort(),
  );
}

test("four screens wrap at narrow widths and each links to its existing device Screen", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`${origin}/screens`);
  await expect(page.getByRole("heading", { name: "Screens", exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toEqual(["four", "one", "three", "two"]);
  await expect(page.locator("canvas")).toHaveCount(4);
  for (const [id, model] of [
    ["four", "Pixel 9"],
    ["one", "iPhone 16"],
    ["three", "iPhone 16"],
    ["two", "iPhone 16"],
  ]) {
    await expect(
      page.getByRole("region", {
        name: `Screen: Synthetic worker (synthetic), ${model} (${id})`,
        exact: true,
      }),
    ).toBeVisible();
  }

  await expect(page.getByRole("link", { name: "Open device Screen" }).first()).toHaveAttribute(
    "href",
    "/fleet/synthetic/four?drawer=screen",
  );
  const boxes = await page
    .locator(".screens-tile")
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y));
  expect(new Set(boxes).size).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("screens-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await expect.poll(async () => (await active(page)).length).toBeLessThan(4);
  await page.screenshot({ path: testInfo.outputPath("screens-narrow.png") });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await expect.poll(() => active(page)).toHaveLength(4);
  expect(
    await page.evaluate(
      () => (window as unknown as { wallTest: Controls }).wallTest.counts.duplicates,
    ),
  ).toBe(0);
});

test("visibility, removal, navigation and authentication loss close captures without multiplying streams; tile failures stay isolated", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`${origin}/screens`);
  await expect.poll(() => active(page)).toHaveLength(4);
  const tileHeight = await page
    .locator(".screens-tile")
    .first()
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.hidden(true));
  await expect.poll(() => active(page)).toEqual([]);
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(
    await page
      .locator(".screens-tile")
      .first()
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(tileHeight);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.hidden(false));
  await expect.poll(() => active(page)).toHaveLength(4);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.fail("two"));
  await expect(page.getByText("Synthetic capture failed", { exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toHaveLength(3);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.end("three"));
  await expect(page.getByText("The lease was released.", { exact: true })).toBeVisible();
  await expect.poll(() => active(page)).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.remove());
  await expect(page.locator(".screens-tile")).toHaveCount(1);
  await expect.poll(() => active(page)).toEqual(["one"]);
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect.poll(() => active(page)).toEqual([]);
  await page.getByRole("link", { name: "Screens", exact: true }).click();
  await expect.poll(() => active(page)).toEqual(["one"]);
  expect(
    await page.evaluate(
      () => (window as unknown as { wallTest: Controls }).wallTest.counts.duplicates,
    ),
  ).toBe(0);
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

test("empty, disabled, disconnected and unsupported tiles explain why no capture is shown", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`${origin}/screens`);
  await expect.poll(() => active(page)).toHaveLength(4);
  for (const [mode, text, count] of [
    ["disabled", "Streaming is off on Synthetic worker.", 4],
    ["disconnected", "Synthetic worker is disconnected.", 4],
    ["empty", "No running devices.", 1],
    ["unsupported", "This device cannot be streamed.", 4],
  ] as const) {
    await page.evaluate(
      (value) => (window as unknown as { wallTest: Controls }).wallTest.mode(value),
      mode,
    );
    await expect(page.getByText(text, { exact: true })).toHaveCount(count);
    await expect.poll(() => active(page)).toEqual([]);
    await expect(page.locator("canvas")).toHaveCount(0);
  }
  await page.evaluate(() => (window as unknown as { wallTest: Controls }).wallTest.mode("empty"));
  await expect(page.getByText("No running devices.", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { wallTest: Controls }).wallTest.mode("connecting"),
  );
  await expect(page.getByText("Waiting for the first frame.", { exact: true })).toHaveCount(4);
});

test("signing out closes every visible capture", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(`${origin}/screens`);
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
