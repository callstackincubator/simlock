import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  ANDROID,
  FIRST_SNAPSHOT,
  freeLoopbackPort,
  listLeases,
  makeAgent,
  warmUp,
  withSharedDaemon,
  type SharedTestEnv,
} from "./index.js";

describe("warmUp", () => {
  it("when a later warm-up lease fails, rejects and leaves none of the warm-up leases it took held", async () => {
    const env = await withSharedDaemon({
      configOverrides: {
        http: { enabled: false, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      driverScript: {
        android: {
          availableOsVersions: ["34"],
          defaultModels: { phone: ["Pixel 8"] },
          knownModels: ["Pixel 8"],
          modelClasses: { "Pixel 8": "phone" },
        },
      },
    });
    try {
      await warmUp(env, ANDROID, 2);
      expect(await listLeases(env)).toEqual([]);
      await env.driverScript.merge({
        android: { failures: { provision: { type: "BootTimeoutError" } } },
      });

      await expect(warmUp(env, ANDROID, 3)).rejects.toThrow(/Timed out waiting for device to boot/);

      expect(await listLeases(env)).toEqual([]);
    } finally {
      await env.teardown();
    }
  });
});

interface RpcCall {
  readonly params?: { readonly command?: string; readonly flags?: Record<string, unknown> };
}

// why: agent-device's CLI bounds a snapshot request by its own --timeout and, without one, by its 90 s default envelope (DAEMON_REQUEST_TIMEOUT_MS, packages/command-registry/src/timeout-policy.ts at v0.21.36), whatever the process timeout is; a stand-in daemon records the request the pinned CLI sends.
describe.skipIf(process.env.SIMLOCK_E2E_AGENT_DEVICE === undefined)("FIRST_SNAPSHOT", () => {
  it("an agent's snapshot run with FIRST_SNAPSHOT reaches agent-device's daemon with a 150000 ms budget", async () => {
    const calls: RpcCall[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url?.endsWith("/health") === true) {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        const call = JSON.parse(body) as RpcCall & { id?: unknown };
        calls.push(call);
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: { ok: false, error: { code: "COMMAND_FAILED", message: "stand-in daemon" } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const env = {
      httpPort: (server.address() as AddressInfo).port,
      cli: () => Promise.resolve({ code: 0 }),
    } as unknown as SharedTestEnv;
    const agent = await makeAgent(env, "first-snapshot", {
      direct: true,
      token: { secret: "stand-in", id: "stand-in" },
    });

    await agent.run(["snapshot"], FIRST_SNAPSHOT);

    expect(calls.map((call) => call.params?.command)).toEqual(["snapshot"]);
    expect(calls[0]?.params?.flags?.["timeoutMs"]).toBe(150_000);
  });
});
