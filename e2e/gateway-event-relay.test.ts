import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { freeLoopbackPort, waitFor, withDaemon } from "./helpers/index.js";
import type { RecordedEvent } from "./helpers/events.js";

/**
 * ADR 0014 §2 and §5 with real processes: a gateway and one worker, the CLI an operator uses.
 * A worker's event keeps its `id` and `timestamp` on the gateway, which is what lets the two
 * event files be joined; `workerId` and the gateway's own `seq` are the only marks of the relay.
 */

async function gatewayWithWorker() {
  const port = await freeLoopbackPort();
  const gateway = await withDaemon({
    configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
    driver: "none",
  });
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

  it("simlock events --follow on a gateway prints an event that arrives during the replay once", async () => {
    const { gateway, worker } = await gatewayWithWorker();
    const gate = await gateReplay(gateway.socketPath);
    try {
      const adminToken = (await readFile(join(gateway.home, "admin.token"), "utf8")).trim();
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

/**
 * A unix-socket proxy in front of the gateway's daemon socket that holds the follower's
 * `events.replay` request until `release()`. Everything else, pushes included, passes through, so
 * an event emitted while the request is held reaches the follower as a push and is then also in
 * the replay taken after the release.
 */
async function gateReplay(upstreamSocket: string) {
  const home = await mkdtemp(join(tmpdir(), "sl-gate-"));
  let held: (() => void) | undefined;
  let released = false;
  const pushed: RecordedEvent[] = [];
  const server = createServer((client) => {
    const upstream = createConnection(upstreamSocket);
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
  await new Promise<void>((resolve) => server.listen(join(home, "daemon.sock"), resolve));
  return {
    home,
    replayHeld: () => held !== undefined,
    pushedEvents: () => pushed,
    release() {
      released = true;
      held?.();
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { force: true, recursive: true });
    },
  };
}
