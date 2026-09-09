import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon, type TestEnv } from "./helpers/index.js";

/**
 * ADR 0005's happy path, over real transports: a real gateway process, real worker processes
 * dialling it over a real WebSocket, and a client reaching the fleet the way a user actually
 * does -- the CLI on the gateway's own machine, and HTTP from anywhere else.
 *
 * Why this file exists at all. `src/daemon/gateway-fleet.e2e.test.ts` already proves lease
 * routing and a real `device.exec` across two worker processes, but it drives them through the
 * daemon's own `dispatch()` in-process. Everything between that dispatcher and a user was
 * unproven for gateway mode: the CLI's own gateway/worker branch, the HTTP lease and exec
 * routes against a gateway, SSE streaming of proxied output, and exit-code propagation. The one
 * out-of-process lease that existed (`e2e/gateway-fleet.test.ts`) deliberately went straight to
 * a worker's own socket, because fleet routing belonged to a later PR than the one that wrote
 * it -- that PR has since landed, and nothing came back to close the gap.
 *
 * These are smoke tests. They prove the layers are wired to each other, not that the routing
 * policy, the queue's ordering rules or the refusal lists are correct -- `src/gateway`'s own
 * suites own that, and duplicating it here would buy nothing for a great deal of wall clock.
 */

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
  /** Seeded straight into the worker's config; used to pin a one-device worker for queueing. */
  readonly limits?: Record<string, unknown>;
}

interface Fleet {
  readonly gateway: TestEnv;
  readonly workers: readonly TestEnv[];
  readonly baseUrl: string;
}

/**
 * A gateway plus its workers, all as separate daemons with their own `SIMLOCK_HOME` (and so
 * their own instance identity), joined over a real uplink.
 *
 * Returns only once the gateway can actually *serve* each worker's models, not merely once the
 * sockets are `connected`: a worker's catalog arrives on its own schedule after the uplink
 * opens, and leasing before it lands fails for a reason that has nothing to do with what any of
 * these tests are about.
 */
async function startFleet(specs: readonly WorkerSpec[], agentId: string): Promise<Fleet> {
  const port = await freeLoopbackPort();
  // `driver: "none"`: a gateway starts no drivers and warns about every worker-only key in its
  // config (ADR 0005 §2), so it gets no fake-driver wiring and no capacity seeding.
  const gateway = await withDaemon({
    agentId,
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port }, mode: "gateway" },
    driver: "none",
  });

  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  expect(minted.code).toBe(0);
  const { secret } = minted.json as { secret: string };

  const workers: TestEnv[] = [];
  for (const spec of specs) {
    const worker = await withDaemon({
      agentId,
      configOverrides: {
        gateway: { label: spec.label, token: secret, url: `ws://127.0.0.1:${port}` },
        ...(spec.limits === undefined ? {} : { limits: spec.limits }),
      },
    });
    await worker.driverScript.set({
      android: { knownModels: [...spec.models], availableOsVersions: ["35"] },
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

/** Reads a finite SSE body, skipping keepalive comments -- the exec route ends the stream on
 * its terminal `exit`/`error` event. Same shape as `device-exec.test.ts`'s own reader. */
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

/** Mints an agent token on the gateway and returns the headers an HTTP client would send. */
async function agentAuth(gateway: TestEnv): Promise<Record<string, string>> {
  const created = await gateway.cli(["token", "create", "--role", "agent"]);
  expect(created.code).toBe(0);
  return {
    authorization: `Bearer ${(created.json as { secret: string }).secret}`,
    "content-type": "application/json",
  };
}

/** A `queued` progress push at a given position, as `contention.test.ts` reads them on one
 * machine -- ADR §10 requires a gateway to report the same states a worker does. */
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

    // 1. Leasing is identical against a gateway (docs/CLI.md, "Against a gateway") -- same
    //    flags, same grant line, plus a `worker` block saying where it landed.
    const leased = await gateway.cli(
      ["lease", "--platform", "android", "--device", "Pixel 8", "--detach"],
      { timeout: 30_000 },
    );
    expect(leased.code).toBe(0);
    const grant = leased.json as Grant;
    expect(grant.lease.worker?.label).toBe("worker-a");
    // ADR §16: the gateway lease id names its worker. Asserted as a prefix rather than parsed,
    // which is exactly what the docs tell a *client* not to do -- this is the fleet's own
    // invariant, not a client reading it.
    expect(grant.lease.id.startsWith(`${grant.lease.worker?.id ?? ""}.`)).toBe(true);

    // 2. §27a: the worker sees the requester namespaced by the gateway, so a local `smoke-agent`
    //    on that machine and this one cannot collide on its one-lease rule. This is the seam the
    //    in-process test cannot see, because it never asks the worker for its own view.
    const worker = workers[0];
    // Thrown rather than optional-chained: a fleet with no worker means the harness is broken,
    // and reading through `undefined` would surface that as a TypeError three lines later
    // instead of as this sentence.
    if (worker === undefined) throw new Error("expected the fleet to have a worker");
    const workerStatus = await worker.cli(["status", "--json"], { timeout: 30_000 });
    expect(workerStatus.code).toBe(0);
    const workerLeases = (workerStatus.json as { leases: { requesterId: string }[] }).leases;
    expect(workerLeases).toHaveLength(1);
    expect(workerLeases[0]?.requesterId).toMatch(/^gw:[^:]+:smoke-agent$/);

    // 3. The CLI branches on `status.get`'s `mode`: against a gateway `simlock adb` sends
    //    `device.exec` instead of spawning locally, prints what streams back on the matching
    //    stream, and exits with the tool's own code. Nothing else in the suite runs that branch.
    //    `input: ""` closes the child's stdin, which models `simlock adb ... < /dev/null` and is
    //    load-bearing here rather than tidiness: against a *worker* the CLI spawns the tool with
    //    inherited stdio and never reads stdin, but against a gateway it must read stdin to EOF
    //    before it can send the one `stdin` string `device.exec` carries (docs/CLI.md). The test
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
    // The *worker's* driver resolved the command -- its own device root is prepended, on a
    // machine the CLI never talked to directly.
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

    // 1. The same request resource a worker serves, answered by a gateway that owns no devices.
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

    // 2. A command that really runs: the gateway proxies it to the worker and relays the
    //    worker's own chunks and exit code back down this SSE stream.
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

    // 3. A **silent, slow** command: the one shape that isolates ADR §19a's `started` push end
    //    to end. `http/app.ts` races the command settling against `started`, and a command that
    //    merely succeeds reaches the same committed `200` either way -- just not until it
    //    exits. So what `started` actually buys is timing, and the assertion has to be about
    //    timing: the response head must arrive while the command is still running. Relaying it
    //    is the gateway's own job (it holds no driver refusal list and cannot know a process
    //    exists any other way), so this is the assertion that fails if that relay is lost.
    //
    //    Verified by mutation: neutering `FleetLeaseCoordinator#exec`'s `onStarted` relay
    //    leaves every other assertion in this file green and fails only the deadline below.
    //    Both weaker versions of this test -- a short silent command, and the refusal in 4 --
    //    passed against that mutation, which is why neither of them is the one that guards it.
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
    // Generously below the command's own 4s: the point is "well before it exits", not a precise
    // latency budget, so this stays honest on a loaded machine while still failing outright if
    // the route waits for the process to finish before answering.
    expect(headHeadersMs).toBeLessThan(2_000);

    const silentFrames = await readSse(silent);
    expect(chunksOf(silentFrames, "stdout")).toBe("");
    expect(silentFrames.at(-1)).toEqual({ data: { exitCode: 0 }, event: "exit" });

    // 4. A refusal that happens *before* any process exists keeps its own status instead: the
    //    route has not committed to a stream, so §19a′'s `PASSTHROUGH_REFUSED` arrives as a
    //    real `422` rather than buried inside an already-committed `200`.
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
  it("queues a fleet-wide FIFO behind a full worker, refuses --no-wait, and serves the waiter on release", async () => {
    // One worker that can run exactly one device, so the fleet's whole capacity is one lease.
    // ADR §10: the gateway keeps a single fleet-wide queue and reports the same codes and
    // progress states a worker's own queue does -- which is what this asserts, over the real
    // CLI, against a daemon that owns no devices at all.
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

    // §14: one lease per requester is fleet-wide, not per machine.
    const repeat = await gateway.cli([...leaseArgs, "--agent-id", "agent-a", "--detach"]);
    expect(repeat.code).toBe(13);
    expect(repeat.error).toMatchObject({ code: "REQUESTER_ALREADY_LEASED" });
    expect(repeat.error?.message).toContain(firstGrant.lease.id);

    // A second requester with nowhere to go is refused rather than queued.
    const noWait = await gateway.cli([
      ...leaseArgs,
      "--agent-id",
      "agent-b",
      "--no-wait",
      "--detach",
    ]);
    expect(noWait.code).toBe(11);
    expect(noWait.error).toMatchObject({ code: "NO_CAPACITY" });

    // A waiter queues, and says so with the same progress push a worker sends.
    const waiter = gateway.cliBackground([...leaseArgs, "--agent-id", "agent-c"]);
    await waitFor(() => waiter.progressEvents().some((event) => isQueuedAt(event, 1)), {
      label: "agent-c queued at position 1 in the gateway's fleet queue",
    });

    // Releasing the only device in the fleet is what dispatches it.
    expect((await gateway.cli(["release", firstGrant.lease.id])).code).toBe(0);
    const served = JSON.parse(await waiter.firstStdoutLine(30_000)) as Grant;
    expect(served.lease.worker?.label).toBe("worker-a");
    expect(served.lease.id).not.toBe(firstGrant.lease.id);

    waiter.kill("SIGTERM");
    await waiter.waitForExit(15_000);
  });

  it("renews and releases a gateway-issued lease by the id the gateway handed out, and caps its own TTL", async () => {
    // The gateway's own cap applies before anything is dispatched (§15), so it is the
    // gateway's value that decides -- not the worker's, which is the 4h default here.
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

    // The id an operator reads back has to be the id every other verb accepts. Round 6 found a
    // projection that broke exactly this for `status.get`, caught only by a unit test -- here it
    // is over the socket, forwarded to the worker and back.
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
    // Released on the worker too, not merely forgotten by the gateway.
    await waitFor(
      async () => {
        const after = await gateway.cli(["status", "--json"]);
        return (after.json as { leases: unknown[] }).leases.length === 0;
      },
      { label: "the released lease is gone from the fleet's own view" },
    );
  });
});
