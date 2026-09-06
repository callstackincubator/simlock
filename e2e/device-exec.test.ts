import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * ADR 0005 §19a-§19e, end to end: a remote agent leases a device over HTTP and then drives it
 * over HTTP, with no shell on the daemon's machine and no second network path.
 *
 * This is the flow the operation exists for. Every layer it crosses is exercised for real --
 * the token, the lease, the route, the dispatcher, the driver's own passthrough resolution,
 * and a genuine child process on the daemon side -- so what it proves that the unit suites
 * cannot is that the scoping, the streamed chunks, the exit code and the authorization all
 * survive the whole trip. The fake driver's passthrough resolves to a node one-liner that
 * prints its argv and honours `--fake-exec-stderr=`, `--fake-exec-exit=` and
 * `--fake-exec-echo-stdin`, which is how a command's second stream, a non-zero exit and its
 * stdin are observable from the far end of an HTTP request.
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

interface Fleet {
  readonly env: TestEnv;
  readonly baseUrl: string;
  token(role: "agent" | "operator"): Promise<Record<string, string>>;
  lease(body: Record<string, unknown>, auth: Record<string, string>): Promise<string>;
  exec(
    leaseId: string,
    body: Record<string, unknown>,
    auth: Record<string, string>,
  ): Promise<Response>;
}

/** One daemon with HTTP on, both fake platforms scripted, and the three calls every flow here
 * makes. Factored out so each test reads as the thing it is proving rather than as setup. */
async function fleet(): Promise<Fleet> {
  const port = await reservePort();
  const env = await withDaemon({
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
  });
  await env.driverScript.set({
    android: { knownModels: ["Pixel 8"], availableOsVersions: ["35"] },
    ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
  });
  const baseUrl = `http://127.0.0.1:${port}`;

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

  return {
    baseUrl,
    env,
    async token(role) {
      const created = await env.cli(["token", "create", "--role", role]);
      expect(created.code).toBe(0);
      return {
        authorization: `Bearer ${(created.json as { secret: string }).secret}`,
        "content-type": "application/json",
      };
    },
    async lease(body, auth) {
      const created = await fetch(`${baseUrl}/v1/lease-requests`, {
        body: JSON.stringify(body),
        headers: auth,
        method: "POST",
      });
      expect(created.status).toBe(201);
      const requestId = ((await created.json()) as { request: { id: string } }).request.id;
      let leaseId = "";
      await waitFor(
        async () => {
          const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
            headers: auth,
          });
          const view = (await polled.json()) as {
            request: { state: string; lease?: { id: string } };
          };
          leaseId = view.request.lease?.id ?? "";
          return view.request.state === "granted";
        },
        { label: "the lease request is granted", timeout: 30_000 },
      );
      expect(leaseId).not.toBe("");
      return leaseId;
    },
    async exec(leaseId, body, auth) {
      return fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
        body: JSON.stringify(body),
        headers: auth,
        method: "POST",
      });
    },
  };
}

function chunksOf(frames: readonly SseFrame[], stream: "stdout" | "stderr"): string {
  return frames
    .filter((frame) => frame.event === "output")
    .map((frame) => frame.data as { stream: string; chunk: string })
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.chunk)
    .join("");
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("device.exec over HTTP", () => {
  it("runs the driver-scoped command on the daemon and streams both its output and its exit code", async () => {
    const { env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const leaseId = await lease({ device: "iPhone 16", os: "18.4", platform: "ios" }, auth);

    const response = await exec(
      leaseId,
      {
        args: ["list", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
        tool: "simctl",
      },
      auth,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSse(response);
    expect(frames.at(-1)).toEqual({ data: { exitCode: 3 }, event: "exit" });
    // The daemon ran the command the *driver* resolved, not the one the client sent: the
    // device root is prepended and the driver's environment reached the child's own process.
    expect(JSON.parse(chunksOf(frames, "stdout"))).toEqual({
      argv: ["/fake/ios", "list", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
      platform: "ios",
    });
    expect(chunksOf(frames, "stderr")).toBe("a warning");

    // `stdin` travels with the request, is written once, and the pipe is then closed -- so a
    // command that reads it sees exactly this and then EOF.
    const echoed = await exec(
      leaseId,
      { args: ["list", "--fake-exec-echo-stdin"], stdin: "piped payload", tool: "simctl" },
      auth,
    );
    expect(echoed.status).toBe(200);
    const echoedFrames = await readSse(echoed);
    expect(echoedFrames.at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });
    expect(JSON.parse(chunksOf(echoedFrames, "stdout"))).toMatchObject({ stdin: "piped payload" });

    await env.cli(["release", leaseId]);
  });

  it("refuses through the driver's own list, and never runs what it refuses", async () => {
    const { env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const leaseId = await lease({ device: "Pixel 8", platform: "android" }, auth);

    // A verb the driver will not proxy is `PASSTHROUGH_REFUSED` here exactly as it is for the
    // local wrapper: the exec route is not a way around the refusal list.
    const refusedVerb = await exec(leaseId, { args: ["kill-server"], tool: "adb" }, auth);
    expect(refusedVerb.status).toBe(422);
    expect(await errorCodeOf(refusedVerb)).toBe("PASSTHROUGH_REFUSED");

    // The one refusal particular to this path: an interactive shell with no terminal to attach
    // it to, refused rather than left to stall until `exec.timeoutMs`.
    const bareShell = await exec(leaseId, { args: ["shell"], tool: "adb" }, auth);
    expect(bareShell.status).toBe(422);
    expect(await errorCodeOf(bareShell)).toBe("PASSTHROUGH_REFUSED");

    // The same command with something to run is not the interactive shell, and goes through.
    const shellWithCommand = await exec(leaseId, { args: ["shell", "getprop"], tool: "adb" }, auth);
    expect(shellWithCommand.status).toBe(200);
    expect((await readSse(shellWithCommand)).at(-1)).toEqual({
      data: { exitCode: 0 },
      event: "exit",
    });

    // A tool no driver on this machine wraps is a request this host cannot serve, not a
    // malformed one.
    const unwrapped = await exec(leaseId, { args: [], tool: "bash" }, auth);
    expect(unwrapped.status).toBe(422);
    expect(await errorCodeOf(unwrapped)).toBe("UNKNOWN_PASSTHROUGH_TOOL");

    await env.cli(["release", leaseId]);
  });

  it("checks ownership per role: an agent's own lease, and an operator that must name its holder", async () => {
    // ADR 0005 §19a': an agent is gated the ordinary way and may not name a requester at all;
    // an operator does *not* get the usual bypass on this operation and must name the one the
    // lease was granted to.
    const { env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const otherAuth = await token("agent");
    const operatorAuth = await token("operator");
    const leaseId = await lease({ device: "iPhone 16", os: "18.4", platform: "ios" }, auth);

    const unknownLease = await exec("lse_nope", { args: ["list"], tool: "simctl" }, auth);
    expect(unknownLease.status).toBe(404);
    expect(await errorCodeOf(unknownLease)).toBe("UNKNOWN_LEASE");

    const someoneElses = await exec(leaseId, { args: ["list"], tool: "simctl" }, otherAuth);
    expect(someoneElses.status).toBe(403);
    expect(await errorCodeOf(someoneElses)).toBe("FORBIDDEN");

    // An agent that names *any* requester is refused outright: identity here is the token's,
    // and answering as if the field had not been sent would read like it was honoured.
    const agentNaming = await exec(
      leaseId,
      { args: ["list"], requesterId: "someone", tool: "simctl" },
      auth,
    );
    expect(agentNaming.status).toBe(403);

    const leases = (await env.cli(["list", "--leases"])).json as readonly {
      id: string;
      requesterId: string;
    }[];
    const holder = leases.find((lease) => lease.id === leaseId)?.requesterId ?? "";
    expect(holder).not.toBe("");

    const operatorWithout = await exec(leaseId, { args: ["list"], tool: "simctl" }, operatorAuth);
    expect(operatorWithout.status).toBe(403);

    const operatorWrong = await exec(
      leaseId,
      { args: ["list"], requesterId: "not-the-holder", tool: "simctl" },
      operatorAuth,
    );
    expect(operatorWrong.status).toBe(403);

    const operatorRight = await exec(
      leaseId,
      { args: ["list"], requesterId: holder, tool: "simctl" },
      operatorAuth,
    );
    expect(operatorRight.status).toBe(200);
    expect((await readSse(operatorRight)).at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });

    await env.cli(["release", leaseId]);
  });
});
