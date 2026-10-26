import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { NodeAgentDeviceHealthProbe } from "./health.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(
  handler: (url: string | undefined) => { readonly body: string },
): Promise<{ readonly baseUrl: string; readonly urls: string[] }> {
  const urls: string[] = [];
  const server = createServer((request, response) => {
    urls.push(request.url ?? "");
    const answer = handler(request.url);
    response.setHeader("content-type", "application/json");
    response.end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, urls };
}

describe("NodeAgentDeviceHealthProbe", () => {
  it("returns the JSON body of GET /health", async () => {
    const { baseUrl, urls } = await serve(() => ({
      body: JSON.stringify({ rpcProtocolVersion: 2, service: "agent-device-daemon" }),
    }));

    await expect(new NodeAgentDeviceHealthProbe().read(baseUrl)).resolves.toEqual({
      rpcProtocolVersion: 2,
      service: "agent-device-daemon",
    });
    expect(urls).toEqual(["/health"]);
  });

  it("rejects on a body that is not JSON", async () => {
    const { baseUrl } = await serve(() => ({ body: "<html>not json</html>" }));

    await expect(new NodeAgentDeviceHealthProbe().read(baseUrl)).rejects.toThrow();
  });
});
