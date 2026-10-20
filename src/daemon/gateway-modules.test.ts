import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentDeviceModuleWith } from "../agent-device/testing.js";
import { FakeDriver } from "../core/testing.js";
import type { GatewayModule, OptionalModuleDefinition } from "../modules/index.js";
import { fakeModule, type FakeModule } from "../modules/testing.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";

const admin = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "test-operator",
  role: "admin",
} as const;

const daemons: DaemonServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test").catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

function definitionsOf(...modules: FakeModule[]): OptionalModuleDefinition<unknown>[] {
  return modules.map((module) => module.definition as OptionalModuleDefinition<unknown>);
}

interface Gateway {
  readonly daemon: DaemonServer;
  readonly clock: FakeClock;
  readonly sink: MemoryLogSink;
  readonly origin: string;
  readonly port: number;
  readonly agentSecret: string;
  readonly start: () => Promise<DaemonServer>;
}

function gatewayOptions(
  modules: readonly OptionalModuleDefinition<unknown>[],
  on: readonly string[],
  directory: string,
  port: number,
  clock: FakeClock,
  sink: MemoryLogSink,
): StartDaemonOptions {
  return {
    clock,
    configOverrides: {
      capabilities: Object.fromEntries(on.map((name) => [name, { enabled: true }])),
      http: { enabled: true, host: "127.0.0.1", port },
    },
    role: "gateway",
    dataDirectory: directory,
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    optionalModules: modules,
    statePath: join(directory, "state.json"),
    version: "1.2.3",
  } as StartDaemonOptions;
}

async function startGateway(
  modules: readonly OptionalModuleDefinition<unknown>[],
  on: readonly string[],
): Promise<Gateway> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-gw-modules-"));
  directories.push(directory);
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const port = await freeLoopbackPort();
  const start = async () => {
    const daemon = await startDaemon(gatewayOptions(modules, on, directory, port, clock, sink));
    daemons.push(daemon);
    return daemon;
  };
  const daemon = await start();
  const agent = await daemon.dispatch("token.create", { label: "agent", role: "agent" }, admin);
  return {
    agentSecret: agent.secret,
    clock,
    daemon,
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    sink,
    start,
  };
}

async function joinWorker(
  gateway: Gateway,
  modules: readonly OptionalModuleDefinition<unknown>[],
  on: readonly string[],
  label: string,
): Promise<DaemonServer> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-gw-worker-"));
  directories.push(directory);
  const { secret } = await gateway.daemon.dispatch(
    "token.create",
    { label, role: "worker" },
    admin,
  );
  const worker = await startDaemon({
    clock: gateway.clock,
    configOverrides: {
      capabilities: Object.fromEntries(on.map((name) => [name, { enabled: true }])),
      gateway: { label, token: secret, url: `ws://127.0.0.1:${String(gateway.port)}` },
    },
    dataDirectory: directory,
    drivers: [
      new FakeDriver({ availableOsVersions: ["26.5"], clock: gateway.clock, platform: "ios" }),
    ],
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    optionalModules: modules,
    statePath: join(directory, "state.json"),
    version: "1.2.3",
  } as StartDaemonOptions);
  daemons.push(worker);
  await vi.waitFor(
    async () => {
      const { workers } = await gateway.daemon.dispatch("worker.list", {}, admin);
      const view = workers.find((entry) => entry.label === label);
      expect(view?.connection).toBe("connected");
      expect(view?.capabilities).toBeDefined();
    },
    { timeout: 10_000 },
  );
  return worker;
}

function get(gateway: Gateway, path: string): Promise<Response> {
  return fetch(`${gateway.origin}${path}`, {
    headers: { authorization: `Bearer ${gateway.agentSecret}`, connection: "close" },
  });
}

const mountPong = () => () => Promise.resolve(new Response("pong"));
const pong: GatewayModule = { mount: mountPong };

describe("a gateway's optional modules", () => {
  it("a gateway with agent-device off mounts no /v1/agent-device, and never calls agent-device's loadGateway, while one with it on does", async () => {
    const definition = agentDeviceModuleWith({});
    const loadGateway = vi.spyOn(definition, "loadGateway");
    const on = await startGateway([definition], ["agent-device"]);
    expect((await get(on, "/v1/agent-device/health")).status).toBe(200);
    expect(loadGateway).toHaveBeenCalledTimes(1);
    await on.daemon.stop("test");
    loadGateway.mockClear();

    const off = await startGateway([definition], []);

    expect((await get(off, "/v1/agent-device/health")).status).toBe(404);
    expect(loadGateway).not.toHaveBeenCalled();
  });

  it("a module turned on with no loadGateway is never loaded on a gateway, and mounts nothing, while one with it is mounted under its name", async () => {
    const bare = fakeModule({ name: "bare" });
    const sided = fakeModule({ gateway: { module: pong }, name: "sided" });

    const gateway = await startGateway(definitionsOf(bare, sided), ["bare", "sided"]);

    expect(await (await get(gateway, "/v1/sided/x")).text()).toBe("pong");
    expect((await get(gateway, "/v1/bare/x")).status).toBe(404);
    expect({ loads: bare.loads, gatewayLoads: sided.gatewayLoads }).toEqual({
      gatewayLoads: 1,
      loads: 0,
    });
  });

  it("a loadGateway() that throws, and a createGateway that throws, each stop the gateway's start with an error naming the module", async () => {
    const loading = fakeModule({
      gateway: { loadError: new Error("no such file") },
      name: "loady",
    });
    const creating = fakeModule({
      gateway: { createError: new Error("bad section") },
      name: "makey",
    });

    await expect(startGateway(definitionsOf(loading), ["loady"])).rejects.toThrow(/loady/);
    await expect(startGateway(definitionsOf(creating), ["makey"])).rejects.toThrow(/makey/);
  });

  it("a fake gateway module's relay sends with its own name as the target, and no other", async () => {
    const seen: string[] = [];
    const answering = (name: string) => () => {
      seen.push(name);
      return Promise.resolve(new Response(`from ${name}`));
    };
    const mine = fakeModule({
      gateway: { module: pong },
      name: "mine",
      relayTarget: answering("mine"),
    });
    const other = fakeModule({ name: "other", relayTarget: answering("other") });
    const gateway = await startGateway(definitionsOf(mine), ["mine"]);
    await joinWorker(gateway, definitionsOf(mine, other), ["mine", "other"], "w1");
    expect(mine.gatewayCreates).toBe(1);
    const context = mine.gatewayContexts[0];
    const [view] = context?.workers() ?? [];

    const answer = await context?.relay(view?.id ?? "", new Request("http://relay.test/x"), "t");

    expect(await answer?.text()).toBe("from mine");
    expect(seen).toEqual(["mine"]);
  });

  it("a fake gateway module's serving() lists only connected workers whose capability named after it is available, a drained one included", async () => {
    const mine = fakeModule({ gateway: { module: pong }, name: "mine" });
    const gateway = await startGateway(definitionsOf(mine), ["mine"]);
    await joinWorker(gateway, definitionsOf(mine), ["mine"], "serves");
    await joinWorker(gateway, definitionsOf(mine), [], "off");
    const unavailable = fakeModule({ name: "mine", state: "unavailable" });
    await joinWorker(gateway, definitionsOf(unavailable), ["mine"], "unavailable");
    const other = fakeModule({ name: "other" });
    await joinWorker(gateway, definitionsOf(other), ["other"], "other");
    const gone = await joinWorker(gateway, definitionsOf(mine), ["mine"], "gone");
    await joinWorker(gateway, definitionsOf(mine), ["mine"], "drained");
    const { workers } = await gateway.daemon.dispatch("worker.list", {}, admin);
    const idOf = (label: string) => workers.find((entry) => entry.label === label)?.id ?? "";
    await gateway.daemon.dispatch("worker.drain", { workerId: idOf("drained") }, admin);
    await gone.stop("test");
    await vi.waitFor(async () => {
      const listed = await gateway.daemon.dispatch("worker.list", {}, admin);
      expect(listed.workers.find((entry) => entry.label === "gone")?.connection).toBe(
        "disconnected",
      );
    });

    expect(mine.gatewayCreates).toBe(1);
    const serving = mine.gatewayContexts[0]?.serving().map((view) => view.id);

    expect(serving?.sort()).toEqual([idOf("serves"), idOf("drained")].sort());
  });

  it("a fake gateway module's beforeDrain runs while the gateway's HTTP front still answers", async () => {
    let during: number | undefined;
    let origin = "";
    let secret = "";
    const mine = fakeModule({
      gateway: {
        module: {
          hooks: {
            beforeDrain: async () => {
              during = (
                await fetch(`${origin}/v1/mine/x`, {
                  headers: { authorization: `Bearer ${secret}` },
                })
              ).status;
            },
          },
          mount: mountPong,
        },
      },
      name: "mine",
    });
    const gateway = await startGateway(definitionsOf(mine), ["mine"]);
    origin = gateway.origin;
    secret = gateway.agentSecret;

    await gateway.daemon.stop("test");

    expect(during).toBe(200);
  });

  it("a fake gateway module whose beforeDrain never settles is logged as ran out of time at 30 s on a fake clock, and the HTTP front still stops and daemon.stop() resolves", async () => {
    let entered = false;
    const mine = fakeModule({
      gateway: {
        module: {
          hooks: {
            beforeDrain: () => {
              entered = true;
              return new Promise<void>(() => undefined);
            },
          },
          mount: mountPong,
        },
      },
      name: "mine",
    });
    const gateway = await startGateway(definitionsOf(mine), ["mine"]);
    let stopped = false;
    const stopping = gateway.daemon.stop("test").then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);

    gateway.clock.advance(29_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(
      gateway.sink.records.some((r) => r.message === "Optional module hook ran out of time"),
    ).toBe(false);

    gateway.clock.advance(1);
    await stopping;

    expect(gateway.sink.records).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ hook: "beforeDrain", module: "mine" }),
        level: "warn",
        message: "Optional module hook ran out of time",
      }),
    );
    await expect(get(gateway, "/v1/mine/x")).rejects.toThrow();
  });
});
