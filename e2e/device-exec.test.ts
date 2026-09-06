import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon } from "./helpers/index.js";

/**
 * ADR 0005 §19a-§19e, end to end: a remote agent leases a device over HTTP and then drives it
 * over HTTP, with no shell on the daemon's machine and no second network path.
 *
 * This is the flow the operation exists for. Every layer it crosses is exercised for real --
 * the token, the lease, the route, the dispatcher, the driver's own passthrough resolution,
 * and a genuine child process on the daemon side -- so what it proves that the unit suites
 * cannot is that the scoping, the streamed chunks and the exit code all survive the whole
 * trip. The fake driver's passthrough resolves to a node one-liner that prints its argv and
 * honours `--fake-exec-stderr=` / `--fake-exec-exit=`, which is how a command's second stream
 * and a non-zero exit are observable from the far end of an HTTP request.
 */

/** Same reservation dance as `http-api.test.ts`: config validation rejects `http.port: 0`. */
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (address === null || typeof address === "string") {
          reject(new Error("failed to reserve a port: no AddressInfo"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

/** Reads the whole SSE body, skipping keepalive comments. The stream is finite here: the route
 * ends it on the terminal `exit`/`error` event. */
async function readSse(response: Response): Promise<SseFrame[]> {
  const body = await response.text();
  const frames: SseFrame[] = [];
  for (const raw of body.split("\n\n")) {
    if (raw.trim() === "" || raw.startsWith(":")) continue;
    let event: string | undefined;
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event === undefined) continue;
    frames.push({ data: JSON.parse(data) as unknown, event });
  }
  return frames;
}

describe("device.exec over HTTP", () => {
  it("leases a device, runs a scoped command on the daemon, and streams its output and exit code", async () => {
    const port = await reservePort();
    const env = await withDaemon({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    });
    await env.driverScript.set({
      ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    const tokenResult = await env.cli(["token", "create", "--role", "agent"]);
    expect(tokenResult.code).toBe(0);
    const agentAuth = {
      authorization: `Bearer ${(tokenResult.json as { secret: string }).secret}`,
    };
    const jsonAuth = { ...agentAuth, "content-type": "application/json" };

    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "HTTP gateway accepting connections" },
    );

    const created = await fetch(`${baseUrl}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", os: "18.4", platform: "ios" }),
      headers: jsonAuth,
      method: "POST",
    });
    expect(created.status).toBe(201);
    const requestId = ((await created.json()) as { request: { id: string } }).request.id;

    let lease: { id: string } | undefined;
    await waitFor(
      async () => {
        const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
          headers: agentAuth,
        });
        const body = (await polled.json()) as {
          request: { state: string; lease?: { id: string } };
        };
        lease = body.request.lease;
        return body.request.state === "granted";
      },
      { label: "the lease request is granted", timeout: 30_000 },
    );
    const leaseId = lease?.id ?? "";

    // The command itself: `simctl list devices`, plus the two flags that make the fake tool
    // write to stderr and exit non-zero.
    const exec = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({
        args: ["list", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
        tool: "simctl",
      }),
      headers: jsonAuth,
      method: "POST",
    });
    expect(exec.status).toBe(200);
    expect(exec.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSse(exec);
    expect(frames.at(-1)).toEqual({ data: { exitCode: 3 }, event: "exit" });

    const output = frames.filter((frame) => frame.event === "output");
    const stdout = output
      .filter((frame) => (frame.data as { stream: string }).stream === "stdout")
      .map((frame) => (frame.data as { chunk: string }).chunk)
      .join("");
    const stderr = output
      .filter((frame) => (frame.data as { stream: string }).stream === "stderr")
      .map((frame) => (frame.data as { chunk: string }).chunk)
      .join("");

    // The daemon ran the command the *driver* resolved, not the one the client sent: the
    // device root is prepended and the driver's environment reached the child's own process.
    expect(JSON.parse(stdout)).toEqual({
      argv: ["/fake/ios", "list", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
      platform: "ios",
    });
    expect(stderr).toBe("a warning");

    // A verb the driver refuses is refused here too, and nothing is spawned for it: the exec
    // route is not a way around the passthrough refusal list.
    const refused = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({ args: ["delete", "ABCD"], tool: "simctl" }),
      headers: jsonAuth,
      method: "POST",
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "PASSTHROUGH_REFUSED",
    );

    // An id that names no lease answers 404 rather than running anything.
    const unknown = await fetch(`${baseUrl}/v1/leases/lse_nope/exec`, {
      body: JSON.stringify({ args: ["list"], tool: "simctl" }),
      headers: jsonAuth,
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );

    await env.cli(["release", leaseId]);
  });
});
