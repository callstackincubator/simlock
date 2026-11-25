import { describe, expect, it } from "vitest";

import { type TestEnv, waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";

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
    const { env: worker, port } = await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    }));

    const url = await consoleUrl(worker);
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    const page = await fetchWhenListening(url ?? "");
    const text = await worker.cli(["status"]);

    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const asset = await fetch(new URL(script ?? "", url));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(text.stdout).toContain(`Console: http://127.0.0.1:${port}/\n`);
  });

  it("a gateway serves the console page at the address simlock status prints", async () => {
    const { env: gateway, port } = await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      role: "gateway",
      driver: "none",
    }));

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
