import { describe, expect, it } from "vitest";

import { type TestEnv, waitFor, withDaemon } from "./helpers/index.js";

async function waitForReadyDevice(env: TestEnv, model: string): Promise<void> {
  await waitFor(
    async () => {
      const rows = (await env.cli(["list", "--devices"])).json as {
        spec: { model: string };
        state: string;
      }[];
      return rows.some((row) => row.state === "ready" && row.spec.model === model);
    },
    { label: `the warm pool makes a ready ${model}` },
  );
}

describe("daemon stop then start", () => {
  // why: #1295. A stop that still has an idle device to shut down holds its socket for that time;
  // the 2 s shutdown latency stands in for a real simulator's shutdown.
  it("daemon start right after daemon stop returns, while the old daemon is still stopping, starts a new daemon and status says running", async () => {
    const env = await withDaemon({
      configOverrides: {
        warmPool: {
          targets: [{ count: 1, model: "iPhone 16", osVersion: "18.4", platform: "ios" }],
        },
      },
      driverScript: { ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] } },
    });
    await waitForReadyDevice(env, "iPhone 16");
    await env.driverScript.merge({ ios: { latencyMs: { shutdown: 2_000 } } });

    const stop = await env.cli(["daemon", "stop"]);
    expect(stop.code, stop.stderr).toBe(0);
    const start = await env.cli(["daemon", "start", "--json"]);

    expect({ code: start.code, stderr: start.stderr, json: start.json }).toEqual({
      code: 0,
      stderr: "",
      json: { status: "running" },
    });
    const status = await env.cli(["daemon", "status", "--json"]);
    expect(status.json).toMatchObject({ daemon: { health: "running", mode: "worker" } });
  }, 60_000);
});
