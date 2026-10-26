import { describe, expect, it } from "vitest";

import {
  mintJoinToken,
  type TestEnv,
  waitFor,
  withDaemon,
  withHttpDaemon,
} from "./helpers/index.js";

interface WorkerView {
  readonly id: string;
  readonly label?: string;
  readonly connection: "connected" | "disconnected" | "incompatible";
  readonly catalog: readonly { readonly platform: string; readonly models: readonly string[] }[];
}

interface Grant {
  readonly lease: {
    readonly id: string;
    readonly ttlDeadline: number;
    readonly worker?: { readonly id: string; readonly label?: string };
  };
}

interface WorkerSpec {
  readonly label: string;
  readonly models: readonly string[];
  readonly limits?: Record<string, unknown>;
}

interface Fleet {
  readonly gateway: TestEnv;
  readonly workers: readonly TestEnv[];
  readonly baseUrl: string;
}

/**
 * why: A gateway plus its workers, all as separate daemons with their own `SIMLOCK_HOME` (and so
 * their own instance identity), joined over a real uplink.
 *
 * Returns only once the gateway can actually *serve* each worker's models, not merely once the
 * sockets are `connected`: a worker's catalog arrives on its own schedule after the uplink
 * opens, and leasing before it lands fails for a reason that has nothing to do with what any of
 * these tests are about.
 */
async function startFleet(specs: readonly WorkerSpec[], agentId: string): Promise<Fleet> {
  // why: `driver: "none"`: a gateway starts no drivers and warns about every worker-only key in its
  // config (ADR 0005 §2), so it gets no fake-driver wiring and no capacity seeding.
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    agentId,
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
    role: "gateway",
    driver: "none",
  }));

  const workers: TestEnv[] = [];
  for (const spec of specs) {
    const worker = await withDaemon({
      agentId,
      configOverrides: {
        gateway: {
          label: spec.label,
          token: await mintJoinToken(gateway),
          url: `ws://127.0.0.1:${port}`,
        },
        ...(spec.limits === undefined ? {} : { limits: spec.limits }),
      },
      // why: Before the daemon starts, not after: the worker reports its catalog as its uplink
      // opens, and the gateway would otherwise only see these models on its 30s refresh.
      driverScript: { android: { knownModels: [...spec.models], availableOsVersions: ["35"] } },
    });
    workers.push(worker);
  }

  await waitFor(
    async () => {
      const listed = await gateway.cli(["worker", "list", "--json"]);
      if (listed.code !== 0) return false;
      const views = (listed.json as { workers: WorkerView[] }).workers;
      if (views.length !== specs.length) return false;
      return specs.every((spec) =>
        views.some(
          (view) =>
            view.label === spec.label &&
            view.connection === "connected" &&
            spec.models.every((model) =>
              view.catalog.some(
                (entry) => entry.platform === "android" && entry.models.includes(model),
              ),
            ),
        ),
      );
    },
    { label: "every worker joined the gateway and its catalog arrived", timeout: 30_000 },
  );

  return { baseUrl: `http://127.0.0.1:${port}`, gateway, workers };
}

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

async function readSse(response: Response): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (const raw of (await response.text()).split("\n\n")) {
    if (raw.trim() === "" || raw.startsWith(":")) continue;
    let event: string | undefined;
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event !== undefined) frames.push({ data: JSON.parse(data) as unknown, event });
  }
  return frames;
}

function chunksOf(frames: readonly SseFrame[], stream: "stdout" | "stderr"): string {
  return frames
    .filter((frame) => frame.event === "output")
    .map((frame) => frame.data as { stream: string; chunk: string })
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.chunk)
    .join("");
}

async function agentAuth(gateway: TestEnv): Promise<Record<string, string>> {
  const created = await gateway.cli(["token", "create", "--role", "agent"]);
  expect(created.code).toBe(0);
  return {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
}

function isQueuedAt(event: unknown, position: number): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as Record<string, unknown>).stage === "queued" &&
    (event as Record<string, unknown>).queuePosition === position
  );
}

describe("gateway smoke", () => {
  it("leases and execs through a gateway from the CLI, with the tool's own exit code", async () => {
    const { gateway, workers } = await startFleet(
      [{ label: "worker-a", models: ["Pixel 8"] }],
      "smoke-agent",
    );

    // why: 1. Leasing is identical against a gateway (the CLI reference) -- same
    //    flags, same grant line, plus a `worker` block saying where it landed.
    const leased = await gateway.cli(
      ["lease", "--platform", "android", "--device", "Pixel 8", "--detach"],
      { timeout: 30_000 },
    );
    expect(leased.code).toBe(0);
    const grant = leased.json as Grant;
    expect(grant.lease.worker?.label).toBe("worker-a");
    expect(grant.lease.id.startsWith(`${grant.lease.worker?.id ?? ""}.`)).toBe(true);

    const worker = workers[0];
    // why: Thrown rather than optional-chained: a fleet with no worker means the harness is broken,
    // and reading through `undefined` would surface that as a TypeError three lines later
    // instead of as this sentence.
    if (worker === undefined) throw new Error("expected the fleet to have a worker");
    const workerStatus = await worker.cli(["status", "--json"], { timeout: 30_000 });
    expect(workerStatus.code).toBe(0);
    const workerLeases = (workerStatus.json as { leases: { requesterId: string }[] }).leases;
    expect(workerLeases).toHaveLength(1);
    expect(workerLeases[0]?.requesterId).toMatch(/^gw:[^:]+:smoke-agent$/);

    // why: 3. The CLI branches on `status.get`'s `mode`: against a gateway `simlock adb` sends
    //    `device.exec` instead of spawning locally, prints what streams back on the matching
    //    stream, and exits with the tool's own code. Nothing else in the suite runs that branch.
    //    `input: ""` closes the child's stdin, which models `simlock adb ... < /dev/null` and is
    //    load-bearing here rather than tidiness: against a *worker* the CLI spawns the tool with
    //    inherited stdio and never reads stdin, but against a gateway it must read stdin to EOF
    //    before it can send the one `stdin` string `device.exec` carries. The test
    //    harness spawns with a pipe it never closes, so without this the CLI waits for an EOF
    //    that never comes -- which is exactly what a real caller would see if it handed simlock
    //    an open pipe it never closed.
    const exec = await gateway.cli(
      [
        "adb",
        "--lease",
        grant.lease.id,
        "devices",
        "--fake-exec-stderr=a warning",
        "--fake-exec-exit=3",
      ],
      { input: "", timeout: 30_000 },
    );
    expect(exec.code).toBe(3);
    expect(exec.stderr).toContain("a warning");
    expect(JSON.parse(exec.stdout)).toEqual({
      argv: ["/fake/android", "devices", "--fake-exec-stderr=a warning", "--fake-exec-exit=3"],
      platform: "android",
    });

    const released = await gateway.cli(["release", grant.lease.id], { timeout: 30_000 });
    expect(released.code).toBe(0);
  });

  it("leases and execs through a gateway over HTTP, streaming output and keeping a refusal's own status", async () => {
    const { baseUrl, gateway } = await startFleet(
      [{ label: "worker-a", models: ["Pixel 8"] }],
      "smoke-agent",
    );
    const auth = await agentAuth(gateway);

    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "the gateway's HTTP port accepting connections" },
    );

    const created = await fetch(`${baseUrl}/v1/lease-requests`, {
      body: JSON.stringify({ device: "Pixel 8", platform: "android" }),
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
      { label: "the fleet granted the lease request", timeout: 30_000 },
    );
    expect(leaseId).not.toBe("");

    const streamed = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({ args: ["devices", "--fake-exec-exit=5"], tool: "adb" }),
      headers: auth,
      method: "POST",
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(streamed);
    expect(frames.at(-1)).toEqual({ data: { exitCode: 5 }, event: "exit" });
    expect(JSON.parse(chunksOf(frames, "stdout"))).toMatchObject({ platform: "android" });

    const slowStartedAt = Date.now();
    const silent = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({
        args: ["devices", "--fake-exec-silent", "--fake-exec-sleep=4000"],
        tool: "adb",
      }),
      headers: auth,
      method: "POST",
    });
    const headHeadersMs = Date.now() - slowStartedAt;
    expect(silent.status).toBe(200);
    expect(silent.headers.get("content-type")).toContain("text/event-stream");
    expect(headHeadersMs).toBeLessThan(2_000);

    const silentFrames = await readSse(silent);
    expect(chunksOf(silentFrames, "stdout")).toBe("");
    expect(silentFrames.at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });

    const refused = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      body: JSON.stringify({ args: ["kill-server"], tool: "adb" }),
      headers: auth,
      method: "POST",
    });
    expect(refused.status).toBe(422);
    expect(refused.headers.get("content-type")).toContain("application/json");
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "PASSTHROUGH_REFUSED",
    );

    await fetch(`${baseUrl}/v1/leases/${leaseId}`, { headers: auth, method: "DELETE" });
  });

  // why: #186: the gateway issued this lease and still holds it, so its single-lease read answers it
  // rather than `404 UNKNOWN_LEASE`, in the shape the HTTP API gives a gateway lease: the
  // lease the request resource reports, plus `workerId`/`worker` naming the machine it lives on.
  it("serves GET /v1/leases/{id} for a lease the gateway granted over HTTP: the granted lease, naming its worker (#186)", async () => {
    const { baseUrl, gateway } = await startFleet(
      [{ label: "worker-a", models: ["Pixel 8"] }],
      "smoke-agent",
    );
    const auth = await agentAuth(gateway);
    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "the gateway's HTTP port accepting connections" },
    );

    const created = await fetch(`${baseUrl}/v1/lease-requests`, {
      body: JSON.stringify({ device: "Pixel 8", platform: "android" }),
      headers: auth,
      method: "POST",
    });
    expect(created.status).toBe(201);
    const requestId = ((await created.json()) as { request: { id: string } }).request.id;

    let grantedLease: { id: string } | undefined;
    await waitFor(
      async () => {
        const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
          headers: auth,
        });
        const view = (await polled.json()) as {
          request: { state: string; lease?: { id: string } };
        };
        grantedLease = view.request.lease;
        return view.request.state === "granted";
      },
      { label: "the fleet granted the lease request", timeout: 30_000 },
    );
    if (grantedLease === undefined)
      throw new Error("expected the granted request to carry a lease");

    const listed = await gateway.cli(["worker", "list", "--json"]);
    expect(listed.code).toBe(0);
    const workerA = (listed.json as { workers: WorkerView[] }).workers.find(
      (view) => view.label === "worker-a",
    );
    if (workerA === undefined) throw new Error("expected worker-a in the gateway's worker list");

    const fetched = await fetch(`${baseUrl}/v1/leases/${grantedLease.id}`, { headers: auth });
    expect({ body: await fetched.json(), status: fetched.status }).toEqual({
      body: {
        lease: {
          ...grantedLease,
          worker: { id: workerA.id, label: "worker-a" },
          workerId: workerA.id,
        },
      },
      status: 200,
    });

    await fetch(`${baseUrl}/v1/leases/${grantedLease.id}`, { headers: auth, method: "DELETE" });
  });

  // why: #253: the HTTP API gives a gateway-issued lease `workerId` and
  // `worker`, and the request resource embeds that object once `granted`. It is handed out in
  // two places: the `201` when the grant lands before any progress, and the stored request read
  // back. The first request provisions, so its `201` is not granted; it warms the device. The
  // second finds that device free and is granted inside its own `201`. All three lease objects count.
  it("returns workerId and worker on a gateway-granted lease, in POST /v1/lease-requests' 201 and in GET /v1/lease-requests/{id} (#253)", async () => {
    const { baseUrl, gateway } = await startFleet(
      [{ label: "worker-a", models: ["Pixel 8"] }],
      "smoke-agent",
    );
    const auth = await agentAuth(gateway);
    await waitFor(
      async () => {
        try {
          return (await fetch(`${baseUrl}/v1/healthz`)).ok;
        } catch {
          return false;
        }
      },
      { label: "the gateway's HTTP port accepting connections" },
    );

    const listed = await gateway.cli(["worker", "list", "--json"]);
    expect(listed.code).toBe(0);
    const workerA = (listed.json as { workers: WorkerView[] }).workers.find(
      (view) => view.label === "worker-a",
    );
    if (workerA === undefined) throw new Error("expected worker-a in the gateway's worker list");

    interface RequestBody {
      readonly request: {
        readonly id: string;
        readonly state: string;
        readonly lease?: Record<string, unknown>;
      };
    }
    const submit = async (): Promise<RequestBody> => {
      const created = await fetch(`${baseUrl}/v1/lease-requests`, {
        body: JSON.stringify({ device: "Pixel 8", platform: "android" }),
        headers: auth,
        method: "POST",
      });
      expect(created.status, await created.clone().text()).toBe(201);
      return (await created.json()) as RequestBody;
    };
    const readGranted = async (requestId: string): Promise<RequestBody> => {
      let body: RequestBody | undefined;
      await waitFor(
        async () => {
          const polled = await fetch(`${baseUrl}/v1/lease-requests/${requestId}?wait=10`, {
            headers: auth,
          });
          body = (await polled.json()) as RequestBody;
          return body.request.state === "granted";
        },
        { label: "the fleet granted the lease request", timeout: 30_000 },
      );
      if (body === undefined) throw new Error("expected the granted request to be read back");
      return body;
    };
    const release = async (body: RequestBody): Promise<void> => {
      const leaseId = body.request.lease?.id;
      if (typeof leaseId !== "string") throw new Error("expected the granted lease to have an id");
      const released = await fetch(`${baseUrl}/v1/leases/${leaseId}`, {
        headers: auth,
        method: "DELETE",
      });
      expect(released.status).toBe(202);
    };

    const first = await submit();
    const firstRead = await readGranted(first.request.id);
    await release(firstRead);
    // why: The release answers before the worker has reclaimed the device. The second request is
    // granted inside its own `201` only once the gateway's view shows that device ready again.
    await waitFor(
      async () => {
        const status = (await (await fetch(`${baseUrl}/v1/status`, { headers: auth })).json()) as {
          devices: { state: string }[];
          leases: unknown[];
        };
        return (
          status.leases.length === 0 &&
          status.devices.length > 0 &&
          status.devices.every((device) => device.state === "ready")
        );
      },
      { label: "the released device ready again in the gateway's view", timeout: 30_000 },
    );

    const second = await submit();
    const secondRead = await readGranted(second.request.id);

    const namesWorkerA = expect.objectContaining({
      worker: { id: workerA.id, label: "worker-a" },
      workerId: workerA.id,
    });
    expect({
      firstRequestRead: firstRead.request.lease,
      secondRequestCreated: { lease: second.request.lease, state: second.request.state },
      secondRequestRead: secondRead.request.lease,
    }).toEqual({
      firstRequestRead: namesWorkerA,
      secondRequestCreated: { lease: namesWorkerA, state: "granted" },
      secondRequestRead: namesWorkerA,
    });

    await release(secondRead);
  });

  it("queues a fleet-wide FIFO behind a full worker, refuses --no-wait, and serves the waiter on release", async () => {
    const { gateway } = await startFleet(
      [
        {
          label: "worker-a",
          limits: { android: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 },
          models: ["Pixel 8"],
        },
      ],
      "smoke-agent",
    );
    const leaseArgs = ["lease", "--platform", "android", "--device", "Pixel 8"] as const;

    const first = await gateway.cli([...leaseArgs, "--agent-id", "agent-a", "--detach"]);
    expect(first.code).toBe(0);
    const firstGrant = first.json as Grant;

    const repeat = await gateway.cli([...leaseArgs, "--agent-id", "agent-a", "--detach"]);
    expect(repeat.code).toBe(13);
    expect(repeat.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(repeat.error?.message).toContain(firstGrant.lease.id);

    const noWait = await gateway.cli([
      ...leaseArgs,
      "--agent-id",
      "agent-b",
      "--no-wait",
      "--detach",
    ]);
    expect(noWait.code).toBe(11);
    expect(noWait.error).toMatchObject({ code: "NO_CAPACITY" });

    const waiter = gateway.cliBackground([...leaseArgs, "--agent-id", "agent-c"]);
    await waitFor(() => waiter.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "agent-c queued at position 1 in the gateway's fleet queue",
    });

    expect((await gateway.cli(["release", firstGrant.lease.id])).code).toBe(0);
    const served = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(served.lease.worker?.label).toBe("worker-a");
    expect(served.lease.id).not.toBe(firstGrant.lease.id);

    waiter.kill("SIGTERM");
    await waiter.waitForExit(15_000);
  });

  it("renews and releases a gateway-issued lease by the id the gateway handed out, and caps its own TTL", async () => {
    const { gateway } = await startFleet(
      [{ label: "worker-a", models: ["Pixel 8"] }],
      "smoke-agent",
    );

    const overCap = await gateway.cli([
      "lease",
      "--platform",
      "android",
      "--device",
      "Pixel 8",
      "--ttl",
      "8h",
      "--detach",
    ]);
    expect(overCap.code).toBe(2);
    expect(overCap.error).toMatchObject({ code: "BAD_REQUEST" });

    const leased = await gateway.cli([
      "lease",
      "--platform",
      "android",
      "--device",
      "Pixel 8",
      "--ttl",
      "10m",
      "--detach",
    ]);
    expect(leased.code).toBe(0);
    const grant = leased.json as Grant;

    const listed = await gateway.cli(["status", "--json"]);
    expect(listed.code).toBe(0);
    const fleetLeases = (listed.json as { leases: { id: string }[] }).leases;
    expect(fleetLeases.map((lease) => lease.id)).toContain(grant.lease.id);

    const renewed = await gateway.cli(["lease", "renew", grant.lease.id]);
    expect(renewed.code).toBe(0);
    const renewedView = renewed.json as { id: string; ttlDeadline: number };
    expect(renewedView.id).toBe(grant.lease.id);
    expect(renewedView.ttlDeadline).toBeGreaterThanOrEqual(grant.lease.ttlDeadline);

    expect((await gateway.cli(["release", grant.lease.id])).code).toBe(0);
    await waitFor(
      async () => {
        const after = await gateway.cli(["status", "--json"]);
        return (after.json as { leases: unknown[] }).leases.length === 0;
      },
      { label: "the released lease is gone from the fleet's own view" },
    );
  });
});
