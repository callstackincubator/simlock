import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { waitFor, withHttpDaemon, type TestEnv } from "./helpers/index.js";

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

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

async function fleet(): Promise<Fleet> {
  const { env, port } = await withHttpDaemon((port) => ({
    configOverrides: {
      http: { enabled: true, host: "127.0.0.1", port },
      diskPressure: { freeBytesThreshold: 0 },
    },
  }));
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

describe("the device.exec fleet", () => {
  // why: the worker refuses an upload while the host's free disk is under this threshold (ADR 0067 §4), so a default of 10 GiB makes the upload tests below pass or fail with the host's free disk.
  it("keeps a disk-pressure threshold of 0 bytes, not the 10 GiB default", async () => {
    const { env } = await fleet();

    const threshold = await env.cli(["config", "get", "diskPressure.freeBytesThreshold"]);

    expect(threshold.code, threshold.stderr).toBe(0);
    expect(threshold.json).toBe(0);
  });
});

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
    expect(JSON.parse(chunksOf(frames, "stdout"))).toEqual({
      argv: ["/fake/ios", "list", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
      cwd: expect.any(String),
      platform: "ios",
    });
    expect(chunksOf(frames, "stderr")).toBe("a warning");

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

  it("runs exec with stdinFile and the command reads the file's bytes, then end of input", async () => {
    const { baseUrl, env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const leaseId = await lease({ device: "iPhone 16", os: "18.4", platform: "ios" }, auth);
    const upload = async (name: string, body: string): Promise<void> => {
      const uploaded = await fetch(`${baseUrl}/v1/leases/${leaseId}/files/${name}`, {
        body,
        headers: { ...auth, "content-type": "application/octet-stream" },
        method: "PUT",
      });
      expect(uploaded.status).toBe(201);
    };
    const nineMiB = "0123456789abcdef".repeat(9 * 65_536);
    await upload("fixture.txt", "stored payload");
    await upload("big.bin", nineMiB);
    await upload("empty.bin", "");

    const reads = [
      { name: "fixture.txt", stdin: "stored payload" },
      { name: "big.bin", stdin: nineMiB },
      { name: "empty.bin", stdin: "" },
      { name: "FIXTURE.TXT", stdin: "stored payload" },
    ];
    for (const { name, stdin } of reads) {
      const response = await exec(
        leaseId,
        { args: ["list", "--fake-exec-echo-stdin"], stdinFile: name, tool: "simctl" },
        auth,
      );
      expect(response.status).toBe(200);
      const frames = await readSse(response);
      expect(frames.at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });
      expect((JSON.parse(chunksOf(frames, "stdout")) as { stdin: string }).stdin === stdin).toBe(
        true,
      );
    }
    const none = await exec(
      leaseId,
      { args: ["list"], stdin: null, stdinFile: null, tool: "simctl" },
      auth,
    );
    expect(none.status).toBe(200);
    expect((await readSse(none)).at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });

    const refusals = [
      { body: { stdinFile: ".hidden" }, code: "BAD_REQUEST", status: 400 },
      { body: { stdinFile: "missing.tar" }, code: "UNKNOWN_FILE", status: 404 },
      { body: { stdin: "x", stdinFile: "fixture.txt" }, code: "BAD_REQUEST", status: 400 },
    ];
    for (const { body, code, status } of refusals) {
      const refused = await exec(leaseId, { args: ["list"], tool: "simctl", ...body }, auth);
      expect(refused.status).toBe(status);
      expect(await errorCodeOf(refused)).toBe(code);
    }

    await env.cli(["release", leaseId]);
  });

  it("runs every exec with the lease's folder as its working folder", async () => {
    const { baseUrl, env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const leaseId = await lease({ device: "iPhone 16", os: "18.4", platform: "ios" }, auth);
    const report = async (args: string[]): Promise<{ cwd: string; fileSize?: number }> => {
      const response = await exec(leaseId, { args, tool: "simctl" }, auth);
      expect(response.status).toBe(200);
      const frames = await readSse(response);
      expect(frames.at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });
      return JSON.parse(chunksOf(frames, "stdout")) as { cwd: string; fileSize?: number };
    };

    // why: no file was uploaded yet, so this shows the folder is made for the command.
    const first = await report(["list"]);
    expect(dirname(await realpath(first.cwd))).toBe(
      join(await realpath(env.dataDirectory), "lease-files"),
    );

    const uploaded = await fetch(`${baseUrl}/v1/leases/${leaseId}/files/fixture.bin`, {
      body: "x".repeat(1234),
      headers: { ...auth, "content-type": "application/octet-stream" },
      method: "PUT",
    });
    expect(uploaded.status).toBe(201);
    const second = await report(["list", "--fake-exec-read-file=fixture.bin"]);
    expect(second.fileSize).toBe(1234);
    expect(await realpath(second.cwd)).toBe(await realpath(first.cwd));

    await env.cli(["release", leaseId]);
  });

  it("refuses through the fake driver's own mirrored list, and never runs what it refuses", async () => {
    const { env, exec, lease, token } = await fleet();
    const auth = await token("agent");
    const leaseId = await lease({ device: "Pixel 8", platform: "android" }, auth);

    // why: A verb the driver will not proxy is `PASSTHROUGH_REFUSED` here exactly as it is for the
    // local wrapper: the exec route is not a way around the refusal list.
    const refusedVerb = await exec(leaseId, { args: ["kill-server"], tool: "adb" }, auth);
    expect(refusedVerb.status).toBe(422);
    expect(await errorCodeOf(refusedVerb)).toBe("PASSTHROUGH_REFUSED");

    // why: The one refusal particular to this path: an interactive shell with no terminal to attach
    // it to, refused rather than left to stall until `exec.timeoutMs`.
    const bareShell = await exec(leaseId, { args: ["shell"], tool: "adb" }, auth);
    expect(bareShell.status).toBe(422);
    expect(await errorCodeOf(bareShell)).toBe("PASSTHROUGH_REFUSED");

    const shellWithCommand = await exec(leaseId, { args: ["shell", "getprop"], tool: "adb" }, auth);
    expect(shellWithCommand.status).toBe(200);
    expect((await readSse(shellWithCommand)).at(-1)).toEqual({
      data: { exitCode: 0 },
      event: "exit",
    });

    const unwrapped = await exec(leaseId, { args: [], tool: "bash" }, auth);
    expect(unwrapped.status).toBe(422);
    expect(await errorCodeOf(unwrapped)).toBe("UNKNOWN_PASSTHROUGH_TOOL");

    await env.cli(["release", leaseId]);
  });

  it("checks ownership per role: an agent's own lease, and an operator that must name its holder", async () => {
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

    // why: An agent that names *any* requester is refused outright: identity here is the token's,
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
