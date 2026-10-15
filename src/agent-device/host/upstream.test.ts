import { describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  FakeProcessSupervisor,
  FakeTcpProbe,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  ScriptedProcessRunner,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { FakeAgentDeviceHealth } from "../testing.js";
import { agentDeviceLeaseMaxTtlMs } from "../shared/daemon-environment.js";
import { AgentDeviceSupervisor } from "./agent-device-supervisor.js";
import { AgentDeviceHost } from "./host.js";
import { SupervisorAgentDeviceUpstream, type AgentDeviceUpstream } from "./upstream.js";

const home = "/home/simlock/.simlock";
const nodePath = "/opt/node/bin/node";
const packageRoot = "/opt/ad/node_modules/agent-device";
const realCli = `${packageRoot}/bin/agent-device.mjs`;
const internalEntry = `${packageRoot}/dist/src/internal/daemon.js`;
const httpPort = 4310;
const daemonToken = "daemon-token";
const leaseMaxTtlMs = 4 * 60 * 60_000;

async function arrange(version: string) {
  const clock = new FakeClock(1_000_000);
  const filesystem = new MemoryFilesystem();
  const probe = new FakeTcpProbe();
  const health = new FakeAgentDeviceHealth();
  health.respondWith({ rpcProtocolVersion: 2, service: "agent-device-daemon" });
  await filesystem.mkdirp(home);
  await filesystem.mkdirp("/usr/local/bin");
  await filesystem.mkdirp(`${packageRoot}/bin`);
  await filesystem.mkdirp(`${packageRoot}/dist/src/internal`);
  await filesystem.writeFileAtomic(realCli, "#!/usr/bin/env node\n");
  filesystem.defineAttributes(realCli, { mode: 0o755 });
  await filesystem.writeFileAtomic(`${packageRoot}/package.json`, '{"name":"agent-device"}');
  await filesystem.writeFileAtomic(internalEntry, "");
  filesystem.defineSymlink("/usr/local/bin/agent-device", realCli);
  const processes = new FakeProcessSupervisor([]);
  const expectations: ScriptedProcessExpectation[] = [
    {
      match: { args: [realCli, "--version"], command: nodePath },
      result: { code: 0, stderr: "", stdout: `${version}\n` },
    },
    {
      hangs: true,
      match: { args: [internalEntry, `--simlock-home=${home}`], command: nodePath },
    },
  ];
  const runner = new ScriptedProcessRunner(expectations);
  const spawn = runner.spawn.bind(runner);
  vi.spyOn(runner, "spawn").mockImplementation((command, args, options) => {
    const handle = spawn(command, args, options);
    if (command !== nodePath || args[0] !== internalEntry) return handle;
    processes.markAlive(handle.pid);
    void filesystem.writeFileAtomic(
      `${home}/agent-device/daemon.json`,
      JSON.stringify({ httpPort, pid: handle.pid, token: daemonToken, version }),
    );
    probe.startListening(httpPort);
    return handle;
  });
  const supervisor = new AgentDeviceSupervisor({
    baseEnvironment: { HOME: "/home/operator", PATH: "/usr/local/bin:/usr/bin" },
    clock,
    config: { command: "agent-device" },
    driverEnvironment: {},
    filesystem,
    healthProbe: health,
    home,
    leaseMaxTtlMs,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: new MemoryLogSink() }),
    nodePath,
    nodeVersion: "22.14.0",
    platforms: ["ios", "android"],
    processRunner: runner,
    processSupervisor: processes,
    tcpProbe: probe,
  });
  return { clock, supervisor, upstream: new SupervisorAgentDeviceUpstream(supervisor) };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function started(harness: Awaited<ReturnType<typeof arrange>>): Promise<void> {
  let settled = false;
  const starting = harness.supervisor.start().finally(() => {
    settled = true;
  });
  starting.catch(() => undefined);
  for (let tick = 0; tick < 4_000 && !settled; tick += 1) {
    await flush();
    harness.clock.advance(100);
  }
  await starting;
}

describe("the agent-device upstream adapter over the supervisor", () => {
  it("reports running with the supervisor's base URL, token, generation and the ceiling", async () => {
    const harness = await arrange("0.21.28");
    await started(harness);
    const availability = harness.supervisor.availability();
    if (availability.state !== "running") throw new Error(`got ${availability.state}`);

    expect(harness.upstream.current()).toEqual({
      baseUrl: availability.baseUrl,
      generation: availability.generation,
      leaseMaxTtlMs: agentDeviceLeaseMaxTtlMs(leaseMaxTtlMs),
      state: "running",
      token: daemonToken,
    });
    expect(availability.baseUrl).toContain(String(httpPort));
  });

  it("reports unavailable with the supervisor's message", async () => {
    const harness = await arrange("0.20.3");
    await started(harness);

    expect(harness.upstream.current()).toEqual({
      reason: "found 0.20.3, need 0.21.28 or later",
      state: "unavailable",
    });
  });

  it("reports unavailable with starting while the supervisor starts", async () => {
    const harness = await arrange("0.21.28");
    const starting = harness.supervisor.start();
    starting.catch(() => undefined);

    expect(harness.upstream.current()).toEqual({ reason: "starting", state: "unavailable" });
  });
});

describe("the agent-device host's authenticate", () => {
  const upstream: AgentDeviceUpstream = {
    current: () => ({ reason: "starting", state: "unavailable" }),
    fetch: async () => new Response(null),
  };

  it("returns the tagged identity's principal as the tenant, and null for a request the front did not tag", () => {
    const host = new AgentDeviceHost(upstream, ["ios"]);
    const tagged = new Request("http://worker/v1/agent-device/rpc");
    host.tag(tagged, { requesterId: "tok_agent", role: "agent" });

    expect(host.authenticate(tagged)).toEqual({ tenantId: "tok_agent" });
    expect(host.authenticate(new Request("http://worker/v1/agent-device/rpc"))).toBeNull();
  });
});
