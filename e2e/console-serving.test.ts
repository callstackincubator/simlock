import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * The daemon serves the built web console at `/` whenever HTTP is enabled, at the address
 * `simlock status` prints. What the page does in a browser is the browser lane's
 * (`pnpm test:console`); this proves the real build is served by the real daemon in both modes.
 */

async function consoleUrl(env: TestEnv): Promise<string | undefined> {
  const status = await env.cli(["status", "--json"]);
  expect(status.code).toBe(0);
  return (status.json as { daemon: { consoleUrl?: string } }).daemon.consoleUrl;
}

async function fetchWhenListening(url: string): Promise<Response> {
  let response: Response | undefined;
  await waitFor(
    async () => {
      try {
        response = await fetch(url);
        return true;
      } catch {
        return false;
      }
    },
    { label: "HTTP listener accepting connections" },
  );
  if (response === undefined) throw new Error("unreachable");
  return response;
}

describe("the web console", () => {
  it("GET / answers the console page when HTTP is enabled", async () => {
    const port = await freeLoopbackPort();
    const worker = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    });

    const url = await consoleUrl(worker);
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    const page = await fetchWhenListening(url ?? "");
    const text = await worker.cli(["status"]);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    // The built page loads its script from the daemon itself, with no token.
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const asset = await fetch(new URL(script ?? "", url));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(text.stdout).toContain(`Console: http://127.0.0.1:${port}/\n`);
  });

  it("a gateway serves the console page at the address simlock status prints", async () => {
    const port = await freeLoopbackPort();
    const gateway = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });

    const url = await consoleUrl(gateway);
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    const page = await fetchWhenListening(url ?? "");

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root"></div>');
  });

  it("simlock status prints no console address when HTTP is disabled", async () => {
    const worker = await withDaemon();

    const text = await worker.cli(["status"]);

    expect(await consoleUrl(worker)).toBeUndefined();
    expect(text.stdout).not.toContain("Console:");
  });
});
