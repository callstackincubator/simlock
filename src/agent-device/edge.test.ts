import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
} from "../ports/index.js";
import { FakeAgentDevice, FakeAgentDeviceHealth } from "./testing.js";
import { AgentDeviceSupervisor } from "./host/agent-device-supervisor.js";
import { SupervisorAgentDeviceUpstream } from "./host/upstream.js";
import { setUpWithPhone, track } from "./test-edge.js";
import {
  secrets,
  notAvailable,
  agentTokenOnly,
  adminSession,
  type Rig,
  sleep,
  setUp,
  send,
  bodyOf,
  envelopeOf,
  hex,
  allocate,
  granted,
  command,
  leases,
  refusal,
} from "./test-support.js";
import { waiting } from "./test-edge-front.js";

// why: Fallow reads a `rig` binding's type only from an annotation in this file, not from an imported
// setUp's return type, so a `rig` whose test calls a FakeAgentDevice member only these tests use is
// annotated `Rig`; without it Fallow reports the member as never referenced.

async function unavailableSupervisor(version: string, reason: "wrong-version" | "start-failed") {
  const clock = new FakeClock(1_000_000);
  const filesystem = new MemoryFilesystem();
  const home = "/home/simlock/.simlock";
  const root = "/opt/ad/node_modules/agent-device";
  const cli = `${root}/bin/agent-device.mjs`;
  const entry = `${root}/dist/src/internal/daemon.js`;
  await filesystem.mkdirp(home);
  await filesystem.mkdirp("/usr/local/bin");
  await filesystem.mkdirp(`${root}/bin`);
  await filesystem.mkdirp(`${root}/dist/src/internal`);
  await filesystem.writeFileAtomic(cli, "#!/usr/bin/env node\n");
  filesystem.defineAttributes(cli, { mode: 0o755 });
  await filesystem.writeFileAtomic(`${root}/package.json`, '{"name":"agent-device"}');
  await filesystem.writeFileAtomic(entry, "");
  filesystem.defineSymlink("/usr/local/bin/agent-device", cli);
  const runner = new ScriptedProcessRunner([
    {
      match: { args: [cli, "--version"], command: "/opt/node/bin/node" },
      result: { code: 0, stderr: "", stdout: `${version}\n` },
    },
  ]);
  const supervisor = new AgentDeviceSupervisor({
    baseEnvironment: { HOME: "/home/operator", PATH: "/usr/local/bin:/usr/bin" },
    clock,
    config: { command: "agent-device" },
    driverEnvironment: {},
    filesystem,
    healthProbe: new FakeAgentDeviceHealth(),
    home,
    hostPlatform: "linux",
    leaseMaxTtlMs: 1_800_000,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    nodePath: "/opt/node/bin/node",
    nodeVersion: "22.14.0",
    platforms: ["ios", "android"],
    processRunner: runner,
    processSupervisor: new FakeProcessSupervisor([]),
    role: "simulators",
    tcpProbe: new FakeTcpProbe(),
  });
  await supervisor.start();
  expect(supervisor.availability()).toMatchObject({ state: "unavailable", reason });
  return new SupervisorAgentDeviceUpstream(supervisor);
}

describe("the agent-device front, through the whole worker daemon", () => {
  it("with capabilities.agent-device.enabled false, and unset on a gateway-mode daemon, /v1/agent-device/health answers 404, as today", async () => {
    const enabled = await setUp();
    expect((await send(enabled, "/health")).status).toBe(200);

    const off = await setUp({ enabled: false });
    expect((await send(off, "/health")).status).toBe(404);

    const gateway = await setUp({ enabled: "unset", gatewayMode: true });
    expect((await send(gateway, "/health")).status).toBe(404);
  });

  it("/v1/agent-device/rpc with no simlock token answers 401, with a worker join token 403, and with an operator token 403 `refused: agent-device through simlock needs an agent token`; the agent-device daemon receives nothing", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const received = rig.fake.requests.length;

    expect((await command(rig, "snapshot", undefined, { token: null })).status).toBe(401);
    expect((await command(rig, "snapshot", undefined, { token: secrets.worker })).status).toBe(403);
    const operator = await command(rig, "snapshot", undefined, { token: secrets.operator });
    expect(operator.status).toBe(403);
    expect(await operator.text()).toContain(agentTokenOnly);

    expect(rig.fake.requests).toHaveLength(received);
  });

  it("/v1/agent-device/health with a simlock token answers the proxy's health, with the agent-device daemon's health under `upstream`", async () => {
    const rig = await setUp();

    const response = await send(rig, "/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "agent-device-proxy",
      upstream: { service: "agent-device-daemon" },
    });
  });

  it("with capabilities.agent-device.enabled true and agent-device unavailable, /health, /rpc and an upload each answer `agent-device is not available on this simlock: <reason>`, nothing is leased, and POST /v1/lease-requests still grants a device", async () => {
    const rig = await setUp();
    const reason = "found 0.20.3, need 0.21.28 or later";
    rig.fake.setUnavailable(reason);

    const health = await send(rig, "/health");
    const rpcAnswer = await allocate(rig, 1);
    const upload = await send(rig, "/upload/preflight", { body: "{}" });

    expect(health.status).toBe(200);
    expect(rpcAnswer.status).toBe(503);
    expect(upload.status).toBe(503);
    expect(await health.text()).toContain(`${notAvailable}${reason}`);
    const rpcError = (await envelopeOf(rpcAnswer)).error;
    expect(rpcError?.message).toBe(`${notAvailable}${reason}`);
    expect(rpcError?.data).toMatchObject({
      details: { reason: "SIMLOCK_UNAVAILABLE" },
      retriable: false,
    });
    const transient = await setUp();
    transient.fake.setUnavailable("starting", true);
    expect((await envelopeOf(await allocate(transient, 3))).error?.data).toMatchObject({
      details: { reason: "SIMLOCK_UNAVAILABLE" },
      retriable: true,
    });
    for (const [version, reason, retriable] of [
      ["0.20.3", "wrong-version", false],
      ["0.21.28", "start-failed", true],
    ] as const) {
      const supervisorUpstream = await unavailableSupervisor(version, reason);
      const supervised = await setUp({ supervisorUpstream });
      const answer = await allocate(supervised, 2);
      expect(answer.status).toBe(503);
      expect((await envelopeOf(answer)).error?.data).toMatchObject({
        details: { reason: "SIMLOCK_UNAVAILABLE" },
        retriable,
      });
    }
    const off = await setUp({
      supervisorUpstream: new SupervisorAgentDeviceUpstream({
        availability: () => ({ state: "off" }),
      }),
    });
    const offAnswer = await allocate(off, 4);
    expect(offAnswer.status).toBe(503);
    expect((await envelopeOf(offAnswer)).error).toMatchObject({
      message: `${notAvailable}off`,
      data: { details: { reason: "SIMLOCK_UNAVAILABLE" }, retriable: false },
    });
    expect(await upload.text()).toContain(`${notAvailable}${reason}`);
    expect(await leases(rig)).toEqual([]);
    expect(rig.fake.requests).toEqual([]);

    const granted = await fetch(`${rig.origin}/v1/lease-requests`, {
      body: JSON.stringify({ device: "iPhone 16", platform: "ios" }),
      headers: { authorization: `Bearer ${secrets.one}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(granted.status).toBe(201);
  });

  it("after the agent-device daemon restarts with a new base URL, token and generation, the next request reaches the new daemon", async () => {
    const rig: Rig = await setUp();
    expect(await bodyOf(await send(rig, "/health"))).toMatchObject({
      upstream: { service: "agent-device-daemon" },
    });
    const before = rig.fake.requests.length;

    rig.fake.restart();
    const response = await send(rig, "/health");

    expect(await bodyOf(response)).toMatchObject({ upstream: { service: "agent-device-daemon" } });
    expect(rig.fake.requests.length).toBeGreaterThan(before);
  });

  it("a command's reply, a streamed progress body included, reaches the CLI unchanged, and a CLI that hangs up during it aborts the request the agent-device daemon was answering", async () => {
    const rig = await setUp();
    const chunks = [
      '{"type":"progress","event":{"kind":"command","message":"one"}}\n',
      '{"type":"progress","event":{"kind":"command","message":"two"}}\n',
      '{"type":"response","response":{"jsonrpc":"2.0","id":"x","result":{"ok":true,"data":{}}}}\n',
    ];
    rig.fake.streamNextCommand(chunks);

    const streamed = await command(
      rig,
      "install",
      undefined,
      {},
      { meta: { uploadedArtifactId: "art-1" } },
    );

    expect(await streamed.text()).toBe(chunks.join(""));

    const plain = await envelopeOf(await command(rig, "snapshot", undefined));
    expect(plain.result).toMatchObject({ command: "snapshot", ok: true });

    rig.fake.holdCommand();
    const hangUp = new AbortController();
    const held = track(command(rig, "snapshot", undefined, { signal: hangUp.signal }));
    await sleep(50);
    expect(held.done()).toBe(false);
    await expect.poll(() => rig.fake.rpcRequests("agent_device.command").length).toBe(3);
    hangUp.abort();
    await held.promise.catch(() => undefined);

    await expect.poll(() => rig.fake.abortedCommands).toEqual(["snapshot"]);
  });

  it("an upload preflight answers a ticket URL under `/v1/agent-device/upload/direct/` on simlock's own origin, carrying the agent's own simlock token, and a `PUT` to it reaches the agent-device daemon", async () => {
    const rig = await setUp();

    const preflight = await send(rig, "/upload/preflight", { body: "{}" });
    expect(preflight.status).toBe(200);
    const ticket = (
      (await preflight.json()) as { upload: { url: string; headers: Record<string, string> } }
    ).upload;

    expect(ticket.url.startsWith(`${rig.origin}/v1/agent-device/upload/direct/`)).toBe(true);
    const carried = Object.entries(ticket.headers).find(
      ([name]) => name.toLowerCase() === "authorization",
    );
    expect(carried?.[1]).toBe(`Bearer ${secrets.one}`);

    const put = await fetch(ticket.url, {
      body: "artifact bytes",
      headers: ticket.headers,
      method: "PUT",
    });

    expect(put.status).toBe(200);
    expect(rig.fake.uploads).toEqual(["artifact bytes"]);
  });

  it("on a worker, an upload preflight and an artifact download follow the `x-agent-device-lease-id` header to the daemon of the lease it names, go to the simulator daemon with no header, and a header naming another token's lease is refused 403 `refused: lease <id> is not one of yours`, and a malformed header is refused `the x-agent-device-lease-id header is not a lease id`", async () => {
    const rig = await setUpWithPhone();
    await granted(rig, 1, { physical: true, platform: "android" });
    await granted(rig, 2, { platform: "android" });
    const named = (n: number) => ({ "x-agent-device-lease-id": hex(n) });
    const malformed = { "x-agent-device-lease-id": "NOT-A-LEASE-ID".repeat(4) };
    const reaching = (fake: FakeAgentDevice, path: string) =>
      fake.requests.filter((request) => request.path === path).length;
    const routes = [
      ["/upload/preflight", { body: "{}" }],
      ["/artifacts/a1", {}],
    ] as const;
    const cases = [
      [named(1), secrets.one, "phone"],
      [named(2), secrets.one, "simulators"],
      [{}, secrets.one, "simulators"],
      [named(1), secrets.two, "forbidden"],
      [malformed, secrets.one, "refused"],
    ] as const;

    for (const [path, body] of routes) {
      for (const [headers, token, reaches] of cases) {
        const [phoneBefore, simulatorsBefore] = [
          reaching(rig.phone, path),
          reaching(rig.fake, path),
        ];

        const answer = await send(rig, path, { ...body, headers, token });

        expect([
          reaching(rig.phone, path) - phoneBefore,
          reaching(rig.fake, path) - simulatorsBefore,
        ]).toEqual([reaches === "phone" ? 1 : 0, reaches === "simulators" ? 1 : 0]);
        if (reaches === "forbidden") {
          expect(answer.status).toBe(403);
          expect(await answer.text()).toContain(`refused: lease ${hex(1)} is not one of yours`);
        }
        if (reaches === "refused") {
          expect(answer.status).toBe(400);
          expect(await answer.text()).toContain(
            "the x-agent-device-lease-id header is not a lease id",
          );
        }
      }
    }
  });

  it("an `/rpc` body over 1 MiB, one that is not JSON, a JSON array, and an object with no `method` are each refused with their message and `id: null`, also while agent-device is unavailable, and neither simlock nor the agent-device daemon sees them", async () => {
    const rig = await setUp();
    expect((await command(rig, "snapshot", undefined)).status).toBe(200);
    const oneMiB = 1024 * 1024;
    const bodies: readonly [string, string][] = [
      [
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "agent_device.command",
          params: { pad: "x".repeat(oneMiB) },
        }),
        "refused: request body over 1 MiB",
      ],
      ["{ not json", "refused: send one JSON-RPC request"],
      ["[]", "refused: send one JSON-RPC request"],
      [JSON.stringify({ id: 3, jsonrpc: "2.0" }), "refused: send one JSON-RPC request"],
    ];

    for (const unavailable of [false, true]) {
      rig.fake.setUnavailable(unavailable ? "starting" : undefined);
      const receivedBefore = rig.fake.requests.length;
      for (const [body, message] of bodies) {
        const answer = await envelopeOf(await send(rig, "/rpc", { body }));
        expect(answer).toMatchObject({ error: refusal(message), id: null, jsonrpc: "2.0" });
      }
      expect(rig.fake.requests).toHaveLength(receivedBefore);
    }
    expect(await waiting(rig)).toEqual([]);
    expect(await leases(rig)).toEqual([]);
  });

  it("`config.get` returns `capabilities.agent-device.leaseTtlCapMs` when it is set, and no `agentDevice` key", async () => {
    const rig = await setUp({ leaseTtlCapMs: 10_000 });

    const config = (await rig.daemon.dispatch("config.get", {}, adminSession)) as {
      readonly capabilities: Record<string, { readonly leaseTtlCapMs?: number }>;
    };

    expect(config.capabilities["agent-device"]?.leaseTtlCapMs).toBe(10_000);
    expect(config).not.toHaveProperty("agentDevice");
  });
});
