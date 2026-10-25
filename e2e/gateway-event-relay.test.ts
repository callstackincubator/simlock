import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeIpcTransport } from "../src/ports/index.js";
import { SimlockWire } from "../src/simlock-client/wire.js";
import { waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";
import type { RecordedEvent } from "./helpers/events.js";

/**
 * ADR 0014 §2 and §5 with real processes: a gateway and one worker, the CLI an operator uses.
 * A worker's event keeps its `id` and `timestamp` on the gateway, which is what lets the two
 * event files be joined; `workerId` and the gateway's own `seq` are the only marks of the relay.
 */

async function gatewayWithWorker() {
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    configOverrides: { http: { host: "127.0.0.1", port } },
    role: "gateway",
    driver: "none",
  }));
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const worker = await withDaemon({
    configOverrides: { gateway: { token: secret, url: `ws://127.0.0.1:${port}` } },
    driverScript: { ios: { knownModels: ["iPhone 17"], availableOsVersions: ["18.4"] } },
  });
  await waitFor(
    async () => (await gateway.events()).some((event) => event.event === "worker.connected"),
    { label: "the worker joined the gateway", timeout: 30_000 },
  );
  return { gateway, worker };
}

function leaseArgs(agentId: string): string[] {
  return [
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 17",
    "--os",
    "18.4",
    "--agent-id",
    agentId,
  ];
}

/** The lines of a stream: a replayed event is printed as itself, a pushed one inside its push. */
function parse(stdout: string): RecordedEvent[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEvent | { readonly event: RecordedEvent })
    .map(
      (printed) => (typeof printed.event === "object" ? printed.event : printed) as RecordedEvent,
    );
}

describe("gateway event relay", () => {
  it("a lease taken on a worker appears in the gateway's simlock events with the worker's id and timestamp plus workerId", async () => {
    const { gateway, worker } = await gatewayWithWorker();

    const held = worker.cliBackground(leaseArgs("relay-join"));
    const grant = JSON.parse(await held.firstStdoutLine()) as { lease: { id: string } };
    const leaseId = grant.lease.id;
    const isGrant = (event: RecordedEvent) =>
      event.event === "lease.granted" &&
      (event.payload as { leaseId?: string }).leaseId === leaseId;

    let relayed: RecordedEvent | undefined;
    await waitFor(
      async () => {
        relayed = (await gateway.events()).find(isGrant);
        return relayed !== undefined;
      },
      { label: "the worker's lease.granted reached the gateway", timeout: 20_000 },
    );
    const own = (await worker.events()).find(isGrant);

    expect(own).toBeDefined();
    expect(relayed?.id).toBe(own?.id);
    expect(relayed?.timestamp).toBe(own?.timestamp);
    expect(relayed?.payload).toEqual({
      ...(own?.payload as object),
      workerId: expect.stringMatching(/\S/),
    });
    expect(own?.payload).not.toHaveProperty("workerId");

    held.kill("SIGTERM");
    await held.waitForExit(15_000);
  });

  it("a granted request leaves one gateway request.granted and a relayed lease.requested and lease.granted whose fleetRequestId is the gateway's own request id", async () => {
    const { gateway } = await gatewayWithWorker();

    const lease = await gateway.cli([...leaseArgs("fleet-granted"), "--detach"], {
      timeout: 30_000,
    });
    expect(lease.code, lease.stderr).toBe(0);
    const gatewayLeaseId = (lease.json as { lease: { id: string } }).lease.id;

    let events: RecordedEvent[] = [];
    await waitFor(
      async () => {
        events = await gateway.events();
        return events.some(
          (event) => event.event === "lease.granted" && "workerId" in (event.payload as object),
        );
      },
      { label: "the worker's lease.granted reached the gateway", timeout: 20_000 },
    );
    const own = (name: string) =>
      events.filter((event) => event.event === name && !("workerId" in (event.payload as object)));
    const relayed = (name: string) =>
      events.filter((event) => event.event === name && "workerId" in (event.payload as object));
    const gatewayRequested = own("lease.requested");
    expect(gatewayRequested).toHaveLength(1);
    const requestId = (gatewayRequested[0]?.payload as { requestId?: string } | undefined)
      ?.requestId;

    expect(own("request.granted").map((event) => event.payload)).toEqual([
      {
        leaseId: gatewayLeaseId,
        requestId,
        worker: expect.stringMatching(/\S/),
        workerLeaseId: expect.stringMatching(/^lse_/),
      },
    ]);
    expect(relayed("lease.requested").map((event) => event.payload)).toEqual([
      expect.objectContaining({ fleetRequestId: requestId }),
    ]);
    expect(relayed("lease.granted").map((event) => event.payload)).toEqual([
      expect.objectContaining({ fleetRequestId: requestId }),
    ]);

    await gateway.cli(["release", gatewayLeaseId], { timeout: 30_000 });
  });

  it("a gateway request whose chosen leaseId a local client already holds on the worker ends in one gateway lease.rejected worker-failed and one relayed lease.declined with the same fleetRequestId, and no relayed lease.rejected", async () => {
    const { gateway, worker } = await gatewayWithWorker();
    const held = worker.cliBackground([...leaseArgs("local-holder"), "--lease-id", "taken-1"]);
    await held.firstStdoutLine();

    const clash = await gateway.cli(
      [...leaseArgs("fleet-clash"), "--lease-id", "taken-1", "--detach"],
      { timeout: 30_000 },
    );
    expect(clash.error).toMatchObject({ code: "LEASE_ID_TAKEN" });

    let events: RecordedEvent[] = [];
    await waitFor(
      async () => {
        events = await gateway.events();
        return events.some((event) => event.event === "lease.declined");
      },
      { label: "the worker's lease.declined reached the gateway", timeout: 20_000 },
    );
    const gatewayRejections = events.filter(
      (event) => event.event === "lease.rejected" && !("workerId" in (event.payload as object)),
    );
    const requested = events.find(
      (event) =>
        event.event === "lease.requested" &&
        !("workerId" in (event.payload as object)) &&
        (event.payload as { requester: string }).requester === "fleet-clash",
    );
    const requestId = (requested?.payload as { requestId?: string } | undefined)?.requestId;

    expect(gatewayRejections.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        code: "LEASE_ID_TAKEN",
        reason: "worker-failed",
        requestId,
        worker: expect.stringMatching(/\S/),
      }),
    ]);
    expect(
      events.filter((event) => event.event === "lease.declined").map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({
        fleetRequestId: requestId,
        reason: "lease-id-taken",
        workerId: expect.stringMatching(/\S/),
      }),
    ]);
    expect(
      events.filter(
        (event) => event.event === "lease.rejected" && "workerId" in (event.payload as object),
      ),
    ).toEqual([]);

    held.kill("SIGTERM");
    await held.waitForExit(15_000);
  });

  it("a gateway pages its events by worker through GET /v1/events, and a worker answers its own id only", async () => {
    const { first, gateway, port, read, second, secret } = await gatewayWithTwoWorkers();
    const holders = [
      first.env.cliBackground(leaseArgs("by-worker-one-a")),
      first.env.cliBackground(leaseArgs("by-worker-one-b")),
      second.env.cliBackground(leaseArgs("by-worker-two")),
    ];
    for (const holder of holders) await holder.firstStdoutLine();
    const refused = await withDaemon({
      configOverrides: {
        gateway: {
          token: (
            (await gateway.cli(["token", "create", "--role", "operator"])).json as {
              secret: string;
            }
          ).secret,
          url: `ws://127.0.0.1:${port}`,
        },
      },
    });
    expect(refused.home).toBeDefined();
    let all: RecordedEvent[] = [];
    await waitFor(
      async () => {
        all = await read("?limit=500");
        return all.some((event) => event.event === "worker.rejected");
      },
      { label: "the gateway kept the refused dial's worker.rejected", timeout: 20_000 },
    );
    const claimed = all
      .filter((event) => event.event === "worker.rejected")
      .map((event) => (event.payload as { workerId: string }).workerId)[0];
    const ofWorker = (id: string) =>
      all.filter(
        (event) =>
          event.event !== "worker.rejected" &&
          (event.payload as { workerId?: string }).workerId === id,
      );
    const expected = ofWorker(first.id);
    expect(expected.length).toBeGreaterThanOrEqual(5);
    expect(idsOf(ofWorker(second.id)).some((id) => idsOf(expected).includes(id))).toBe(false);

    const newest = await read(`?worker=${first.id}&limit=100`);
    expect(idsOf(newest)).toEqual(idsOf(expected));
    const lastTwo = await read(`?worker=${first.id}&limit=2`);
    expect(idsOf(lastTwo)).toEqual(idsOf(expected.slice(-2)));
    const olderTwo = await read(`?worker=${first.id}&before=${lastTwo[0]?.id}&limit=2`);
    expect(idsOf(olderTwo)).toEqual(idsOf(expected.slice(-4, -2)));
    expect(idsOf(await read(`?worker=${first.id}&since=1h`))).toEqual(idsOf(expected));
    expect(idsOf(await read(`?worker=${first.id}`))).toEqual(idsOf(expected));
    expect(await read(`?worker=${claimed}&limit=100`)).toEqual([]);
    expect(await read("?worker=nobody&limit=100")).toEqual([]);

    const wire = new SimlockWire(await new NodeIpcTransport().connect(first.env.socketPath));
    try {
      const adminToken = (
        await readFile(join(first.env.dataDirectory, "admin.token"), "utf8")
      ).trim();
      await wire.hello({ credential: adminToken, principal: "relay-by-worker" });
      const own = (await wire.call("events.replay", {})) as RecordedEvent[];
      expect(own.length).toBeGreaterThan(0);
      expect(
        idsOf((await wire.call("events.replay", { workerId: first.id })) as RecordedEvent[]),
      ).toEqual(idsOf(own));
      expect(await wire.call("events.replay", { workerId: second.id })).toEqual([]);
    } finally {
      await wire.close();
    }
    expect(secret).toBeDefined();
    for (const holder of holders) {
      holder.kill("SIGTERM");
      await holder.waitForExit(15_000);
    }
  });

  it("simlock events --follow on a gateway prints an event that arrives during the replay once", async () => {
    const { gateway, worker } = await gatewayWithWorker();
    const gate = await gateReplay(gateway.socketPath);
    try {
      const adminToken = (
        await readFile(join(gateway.dataDirectory, "admin.token"), "utf8")
      ).trim();
      const follower = gateway.cliBackground(["events", "--follow", "--since", "1h"], {
        env: { SIMLOCK_ADMIN_TOKEN: adminToken, SIMLOCK_HOME: gate.home },
      });
      // The follower has subscribed and asked for the replay; the gate holds that request.
      await waitFor(() => gate.replayHeld(), { label: "the replay request reached the gate" });

      // A lease is granted while the replay is pending: its push reaches the follower, and the
      // replay, released only afterwards, is taken after the grant and holds it too.
      const holder = worker.cliBackground(leaseArgs("relay-follow"));
      const grant = JSON.parse(await holder.firstStdoutLine()) as { lease: { id: string } };
      const isGrant = (event: RecordedEvent) =>
        event.event === "lease.granted" &&
        (event.payload as { leaseId?: string }).leaseId === grant.lease.id;
      await waitFor(() => gate.pushedEvents().some(isGrant), {
        label: "the grant's push reached the follower",
        timeout: 20_000,
      });
      gate.release();

      await waitFor(() => parse(follower.stdoutSoFar()).some(isGrant), {
        label: "the follower printed the grant",
      });
      holder.kill("SIGTERM");
      await holder.waitForExit(15_000);
      await waitFor(() => parse(follower.stdoutSoFar()).some((e) => e.event === "lease.released"), {
        label: "the follower printed the release",
        timeout: 20_000,
      });
      follower.kill("SIGTERM");
      await follower.waitForExit(15_000);

      const printed = parse(follower.stdoutSoFar());
      expect(printed.filter(isGrant)).toHaveLength(1);
      const ids = printed.map((event) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await gate.close();
    }
  });
});

interface JoinedWorker {
  readonly id: string;
  readonly env: Awaited<ReturnType<typeof withDaemon>>;
}

async function gatewayWithTwoWorkers() {
  const { env: gateway, port } = await withHttpDaemon((port) => ({
    configOverrides: { http: { host: "127.0.0.1", port } },
    role: "gateway",
    driver: "none",
  }));
  const minted = await gateway.cli(["token", "create", "--role", "worker"]);
  const { secret } = minted.json as { secret: string };
  const join = async (label: string): Promise<JoinedWorker> => {
    const env = await withDaemon({
      configOverrides: { gateway: { label, token: secret, url: `ws://127.0.0.1:${port}` } },
      driverScript: { ios: { knownModels: ["iPhone 17"], availableOsVersions: ["18.4"] } },
    });
    let id: string | undefined;
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const workers = (listed.json as { workers: { id: string; label?: string }[] }).workers;
        id = workers.find((worker) => worker.label === label)?.id;
        return id !== undefined;
      },
      { label: `${label} joined the gateway`, timeout: 30_000 },
    );
    return { env, id: id as string };
  };
  const first = await join("worker-one");
  const second = await join("worker-two");
  const operator = await gateway.cli(["token", "create", "--role", "operator"]);
  const authorization = `Bearer ${(operator.json as { secret: string }).secret}`;
  const read = async (query: string): Promise<RecordedEvent[]> => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/events${query}`, {
      headers: { authorization },
    });
    expect(response.status, query).toBe(200);
    return ((await response.json()) as { events: RecordedEvent[] }).events;
  };
  return { first, gateway, operator, port, read, second, secret };
}

const idsOf = (events: readonly RecordedEvent[]) => events.map((event) => event.id);

/**
 * A unix-socket proxy in front of the gateway's daemon socket that holds the follower's
 * `events.replay` request until `release()`. Everything else, pushes included, passes through, so
 * an event emitted while the request is held reaches the follower as a push and is then also in
 * the replay taken after the release.
 */
async function gateReplay(upstreamSocket: string) {
  const home = await mkdtemp(join(tmpdir(), "sl-gate-"));
  // why: the follower runs with `--gateway`, which looks for a gateway folder under this root.
  const gatewayFolder = join(home, "gateway");
  await mkdir(gatewayFolder);
  await writeFile(join(gatewayFolder, "config.json"), "{}");
  let held: (() => void) | undefined;
  let released = false;
  const pushed: RecordedEvent[] = [];
  const open = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection(upstreamSocket);
    open.add(client);
    open.add(upstream);
    let fromClient = "";
    let fromUpstream = "";
    client.on("data", (chunk: Buffer) => {
      fromClient += chunk.toString("utf8");
      const lines = fromClient.split("\n");
      fromClient = lines.pop() ?? "";
      for (const line of lines) {
        const forward = () => upstream.write(`${line}\n`);
        if ((JSON.parse(line) as { type?: string }).type === "events.replay" && !released) {
          held = forward;
        } else forward();
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      fromUpstream += chunk.toString("utf8");
      const lines = fromUpstream.split("\n");
      fromUpstream = lines.pop() ?? "";
      for (const line of lines) {
        const frame = JSON.parse(line) as { push?: string; payload?: { event?: RecordedEvent } };
        if (frame.push === "event" && frame.payload?.event !== undefined) {
          pushed.push(frame.payload.event);
        }
        client.write(`${line}\n`);
      }
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(join(gatewayFolder, "daemon.sock"), resolve));
  return {
    home,
    replayHeld: () => held !== undefined,
    pushedEvents: () => pushed,
    release() {
      released = true;
      held?.();
    },
    async close() {
      // `server.close` waits for every open connection; destroy them so a failed assertion in
      // the test body is reported, not replaced by a timeout here.
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { force: true, recursive: true });
    },
  };
}
