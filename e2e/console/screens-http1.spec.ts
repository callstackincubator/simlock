import { createServer, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { expect, test } from "@playwright/test";

test("keeps HTTP/1 reads moving with excess screens and promotes waiting captures after cleanup", async ({
  page,
}, testInfo) => {
  const devices = new Map([
    ["a", ["one", "two", "three"]],
    ["b", ["one", "two", "three"]],
  ]);
  const captures = new Map<string, ServerResponse>();
  const held = new Set<ServerResponse>();
  const history: { kind: string; key: string; active: number }[] = [];
  let events: ServerResponse | undefined;
  let workerReads = 0;
  const versions = new Set<string>();
  let duplicates = 0;
  let unauthorized = false;
  const packet = (tag: number, value: Buffer) => {
    const out = Buffer.alloc(value.length + 5);
    out.writeUInt32BE(value.length + 1);
    out[4] = tag;
    value.copy(out, 5);
    return out;
  };
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = 390;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#192c3b";
      context.fillRect(0, 0, 180, 390);
      context.fillStyle = "white";
      context.fillText("Synthetic HTTP/1 fixture", 8, 100);
      return canvas.toDataURL("image/jpeg").split(",")[1]!;
    }),
    "base64",
  );
  const emit = () =>
    events!.write(
      `event: device.ready\ndata: ${JSON.stringify({ id: "synthetic-change", seq: workerReads, timestamp: Date.now(), event: "device.ready", payload: { deviceId: "four" } })}\n\n`,
    );
  const server = createServer(async (req, res) => {
    versions.add(req.httpVersion);
    const path = req.url!;
    const json = (value: unknown, status = 200) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (path.startsWith("/v1/") && unauthorized) {
      json({ error: { code: "UNAUTHORIZED", message: "Synthetic signed out" } }, 401);
      return;
    }
    if (path === "/v1/events/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      events = res;
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    if (path.startsWith("/v1/stream/")) {
      const [, worker, device] = /workers\/([^/]+)\/devices\/([^/]+)/.exec(path)!;
      const key = `${worker}/${device}`;
      if (captures.has(key)) duplicates++;
      captures.set(key, res);
      held.add(res);
      history.push({ kind: "open", key, active: captures.size });
      res.on("close", () => {
        if (captures.get(key) === res) captures.delete(key);
        held.delete(res);
        history.push({ kind: "close", key, active: captures.size });
      });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(
        packet(5, Buffer.from(JSON.stringify({ codec: "mjpeg", width: 180, height: 390, fps: 5 }))),
      );
      res.write(packet(3, jpeg));
      return;
    }
    if (path === "/v1/workers") {
      workerReads++;
      json({
        workers: [...devices].map(([id, ids]) => ({
          id,
          label: "Synthetic worker",
          connection: "connected",
          drained: false,
          lastSeenAt: 0,
          capabilities: [{ name: "stream", state: "available" }],
          devices: ids.map((id) => ({
            id,
            state: "ready",
            physical: false,
            spec: { platform: "ios", model: "iPhone", osVersion: "18.4" },
          })),
        })),
      });
      return;
    }
    const answers: Record<string, unknown> = {
      "/v1/identity": { name: "Synthetic operator", via: "token" },
      "/v1/healthz": { ok: true },
      "/v1/status": { daemon: { mode: "worker", version: "0.5.0" } },
      "/v1/inbox": { items: [], now: Date.now() },
    };
    if (Object.hasOwn(answers, path)) {
      json(answers[path]);
      return;
    }
    if (path.startsWith("/v1/")) {
      json({});
      return;
    }
    try {
      const file = resolve("dist/ui", "." + (path.startsWith("/assets/") ? path : "/index.html"));
      const bytes = await readFile(file);
      res.setHeader(
        "Content-Type",
        (
          { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" } as Record<
            string,
            string
          >
        )[extname(file)] ?? "application/octet-stream",
      );
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await page.addInitScript(() =>
      sessionStorage.setItem("simlock.operatorToken", "synthetic-test-token"),
    );
    await page.setViewportSize({ width: 1900, height: 1900 });
    await page.clock.install();
    await page.goto(`${origin}/screens`);
    await expect(page.locator(".screens-tile")).toHaveCount(6);
    await expect.poll(() => captures.size).toBeGreaterThanOrEqual(4);
    const beforePoll = workerReads;
    await page.clock.runFor(15_001);
    await expect.poll(() => workerReads).toBeGreaterThan(beforePoll);
    expect([...versions]).toEqual(["1.1"]);
    await expect(
      page.getByText("Paused: 4 screens are already capturing.", { exact: true }),
    ).toHaveCount(2);
    await expect.poll(() => captures.size).toBe(4);
    expect(await page.locator("canvas").count()).toBe(4);
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .evaluateAll((nodes) =>
            nodes.every(
              (node) =>
                (node as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data[3] ===
                255,
            ),
          ),
      )
      .toBe(true);
    devices.get("a")!.push("four");
    emit();
    await page.clock.runFor(350);
    await expect(page.locator(".screens-tile")).toHaveCount(7);
    expect(await page.evaluate(async () => (await fetch("/v1/healthz")).status)).toBe(200);
    const first = captures.keys().next().value!;
    const [worker, device] = first.split("/");
    devices.set(
      worker!,
      devices.get(worker!)!.filter((id) => id !== device),
    );
    emit();
    await page.clock.runFor(350);
    await expect(page.locator(".screens-tile")).toHaveCount(6);
    await expect.poll(() => captures.has(first)).toBe(false);
    await expect.poll(() => captures.size).toBe(4);
    const failed = captures.keys().next().value!;
    captures.get(failed)!.write(Buffer.from([255, 255, 255, 255, 1]));
    await expect(
      page.getByText("The stream is not a frame envelope", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => captures.has(failed)).toBe(false);
    await expect.poll(() => captures.size).toBe(4);
    expect(await page.locator("canvas").count()).toBe(4);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => captures.size).toBe(0);
    await expect(page.locator("canvas")).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => captures.size).toBe(4);
    await page.getByRole("link", { name: "Fleet", exact: true }).click();
    await expect.poll(() => captures.size).toBe(0);
    await page.getByRole("link", { name: "Screens", exact: true }).click();
    await expect.poll(() => captures.size).toBe(4);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect.poll(() => captures.size).toBe(0);
    await page.goto(`${origin}/screens`);
    await expect.poll(() => captures.size).toBe(4);
    unauthorized = true;
    emit();
    await page.clock.runFor(350);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect.poll(() => captures.size).toBe(0);
    expect(duplicates).toBe(0);
  } finally {
    try {
      const record = testInfo.outputPath("http1-ownership-history.json");
      await writeFile(
        record,
        JSON.stringify({ versions: [...versions], history, workerReads, duplicates }, null, 2),
      );
      await testInfo.attach("http1-ownership-history", {
        path: record,
        contentType: "application/json",
      });
    } finally {
      try {
        await page.close();
      } finally {
        try {
          for (const response of held) response.destroy();
        } finally {
          try {
            server.closeAllConnections();
          } finally {
            await new Promise<void>((done) => server.close(() => done()));
          }
        }
      }
    }
  }
});
