import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";

// why: a daemon's version check runs `npm view simlock@latest` at start, and the npm child inherits the daemon's environment, so `npm_config_registry` sends what it asks to this server instead of the real registry (#1885).
async function recordingRegistry(): Promise<{ server: Server; url: string; paths: string[] }> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no registry port");
  return { server, url: `http://127.0.0.1:${String(address.port)}/`, paths };
}

describe("the e2e lane's daemons", () => {
  let registry: Awaited<ReturnType<typeof recordingRegistry>> | undefined;

  afterEach(async () => {
    await new Promise((resolve) => registry?.server.close(resolve));
  });

  it("ask no npm registry for the latest Simlock, worker and gateway alike", async () => {
    registry = await recordingRegistry();
    const extraEnv = { npm_config_registry: registry.url };

    await withDaemon({ extraEnv });
    await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      driver: "none",
      extraEnv,
      role: "gateway",
    }));
    const paths = registry.paths;
    // why: the check starts with the daemon; npm boots and asks within a few seconds, so a lane daemon that asks shows two paths well inside this window.
    await waitFor(() => paths.length >= 2, { timeout: 10_000 }).catch(() => undefined);

    expect(paths).toEqual([]);
  });
});
