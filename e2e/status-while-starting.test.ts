import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";

describe("status while the daemon is starting", () => {
  it("a daemon held in starting answers simlock status with the starting line, and GET /v1/status with daemon and host only", async () => {
    const port = await freeLoopbackPort();
    const env = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    });
    // Minting a token is an operation that waits for a started daemon, so it comes first.
    const minted = await env.cli(["token", "create", "--role", "agent"]);
    expect(minted.code, minted.stderr).toBe(0);
    const { secret } = minted.json as { secret: string };

    // Restart the daemon with the fake driver holding its startup check (`listManaged`) open
    // long enough for every read below. `daemon start` returns once startup finishes, so it
    // runs in the background while the reads go to the socket it claims first.
    expect((await env.cli(["daemon", "stop"])).code).toBe(0);
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["26.0"],
        knownModels: ["iPhone 16"],
        latencyMs: { listManaged: 8_000 },
      },
    });
    const start = env.cliBackground(["daemon", "start"]);
    await waitFor(() => existsSync(env.socketPath), { label: "daemon claimed its socket" });

    const human = await env.cli(["status"]);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("Daemon: starting (worker)");
    expect(human.stdout).toContain("Devices, leases and capacity appear once startup finishes.");
    expect(human.stdout).not.toMatch(/^(Device |Lease |Capacity |Queue depth|Running global)/m);

    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { daemon: { health: string } };
    expect(Object.keys(body).sort()).toEqual(["daemon", "host"]);
    expect(body.daemon.health).toBe("starting");

    expect((await start.waitForExit(30_000)).code).toBe(0);
  });
});
