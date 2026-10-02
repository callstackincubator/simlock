import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * What `daemon.log` records, read back from the file a real daemon wrote: one `operation` line
 * per call that changes state, a line per handled background failure, and at `debug` the read
 * calls and every device command.
 */

interface LogLine {
  readonly level: string;
  readonly module: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

async function logLines(env: TestEnv): Promise<LogLine[]> {
  const text = await readFile(env.logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogLine);
}

const IOS = { ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] } };

async function leaseDetached(env: TestEnv): Promise<string> {
  const lease = await env.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--detach",
  ]);
  expect(lease.code, lease.stderr).toBe(0);
  return (lease.json as { lease: { id: string } }).lease.id;
}

/** Config validation rejects `http.port: 0`, so a free port is found first. */
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });
}

describe("daemon.log", () => {
  it("a scripted boot failure leaves a line naming the device and the driver's error text", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        ...IOS.ios,
        failures: { makeReady: { type: "generic", message: "scripted boot failure 7f3a" } },
      },
    });

    const lease = await env.cli([
      "lease",
      "--platform",
      "ios",
      "--device",
      "iPhone 16",
      "--os",
      "18.4",
      "--detach",
    ]);
    expect(lease.code).not.toBe(0);

    const failures = (await logLines(env)).filter((line) =>
      String(line.fields?.error ?? "").includes("scripted boot failure 7f3a"),
    );
    expect(failures).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ deviceId: expect.any(String), step: "boot" }),
      }),
    );
  });

  it("at debug, a device.exec command leaves one process line with its exit code and no line holding its output", async () => {
    const port = await reservePort();
    const env = await withDaemon({
      configOverrides: {
        http: { enabled: true, host: "127.0.0.1", port },
        log: { level: "debug" },
      },
    });
    await env.driverScript.set(IOS);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP accepting connections" },
    );
    // `device.exec` is for the lease's own holder, so the lease is taken with the same token.
    const created = await env.cli(["token", "create", "--role", "agent"]);
    const auth = {
      authorization: `Bearer ${(created.json as { secret: string }).secret}`,
      "content-type": "application/json",
    };
    const requested = await fetch(`${baseUrl}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", os: "18.4", platform: "ios" }),
      headers: auth,
      method: "POST",
    });
    expect(requested.status).toBe(201);
    const requestId = ((await requested.json()) as { request: { id: string } }).request.id;
    let leaseId = "";
    await waitFor(
      async () => {
        const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
          headers: auth,
        });
        const view = (await polled.json()) as { request: { lease?: { id: string } } };
        leaseId = view.request.lease?.id ?? "";
        return leaseId !== "";
      },
      { label: "the lease request is granted" },
    );

    const response = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({
        args: ["printed-output-9c1e", "--fake-exec-exit=4"],
        tool: "simctl",
      }),
      headers: auth,
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("printed-output-9c1e");

    let processLines: LogLine[] = [];
    await waitFor(
      async () => {
        processLines = (await logLines(env)).filter(
          (line) =>
            line.message === "process" &&
            (line.fields?.args as unknown[] | undefined)?.includes("printed-output-9c1e") === true,
        );
        return processLines.length > 0;
      },
      { label: "the device.exec process line" },
    );
    expect(processLines).toEqual([
      expect.objectContaining({
        level: "debug",
        module: "daemon.process",
        fields: expect.objectContaining({ code: 4, durationMs: expect.any(Number) }),
      }),
    ]);
    // The child prints its own argv as JSON; that output never reaches the log.
    const raw = await readFile(env.logPath, "utf8");
    expect(raw).not.toContain('"argv"');
    await env.cli(["release", leaseId]);
  });

  it("simlock daemon logs --follow prints the operation line of a lease made after it started", async () => {
    const env = await withDaemon({ agentId: "follow-agent" });
    await env.driverScript.set(IOS);
    const follower = env.cliBackground(["daemon", "logs", "--follow"]);
    await waitFor(() => follower.stdoutSoFar().includes("Daemon started"), {
      label: "the follower printed the existing tail",
    });
    expect(follower.stdoutSoFar()).not.toContain('"operation":"lease.request"');

    const leaseId = await leaseDetached(env);

    await waitFor(() => follower.stdoutSoFar().includes('"operation":"lease.request"'), {
      label: () => `the lease.request line, follower printed:\n${follower.stdoutSoFar()}`,
    });
    follower.kill("SIGINT");
    expect((await follower.waitForExit(10_000)).code).toBe(0);
    await env.cli(["release", leaseId]);
  });

  it("simlock daemon logs --follow keeps printing lines written after the log rotates", async () => {
    const env = await withDaemon({ configOverrides: { log: { rotateBytes: 1_500 } } });
    await env.driverScript.set(IOS);
    const follower = env.cliBackground(["daemon", "logs", "--follow"]);
    await waitFor(() => follower.stdoutSoFar().includes("Daemon started"), {
      label: "the follower printed the existing tail",
    });

    // Each cycle writes about 1 kB, so five of them rotate the log several times. A cycle waits
    // for the follower before the next one: only one rotated generation is kept, so a second
    // rotation inside one poll would delete lines before any reader could see them.
    let lastLeaseId = "";
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const leaseId = await leaseDetached(env);
      lastLeaseId = leaseId;
      expect((await env.cli(["release", leaseId])).code).toBe(0);
      await waitFor(() => follower.stdoutSoFar().includes(`"leaseId":"${leaseId}"`), {
        label: () => `release line ${cycle}, follower printed:\n${follower.stdoutSoFar()}`,
      });
    }

    // The log has rotated, and the last release line -- already printed above -- sits in the
    // file started by a rotation, so it was written after one.
    await expect(readFile(`${env.logPath}.1`, "utf8")).resolves.not.toBe("");
    const current = await readFile(env.logPath, "utf8");
    expect(current).toContain(`"leaseId":"${lastLeaseId}"`);
    follower.kill("SIGINT");
    expect((await follower.waitForExit(10_000)).code).toBe(0);
  });
});
