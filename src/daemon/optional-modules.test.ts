import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentDeviceModuleWith, FakeAgentDevice } from "../agent-device/testing.js";
import { FakeDriver } from "../core/testing.js";
import type { OptionalModuleDefinition, WorkerHooks } from "../modules/index.js";
import { fakeModule, type FakeModule } from "../modules/testing.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import { openRelay, openUplink, relayInput, settleWithin } from "./test-relay-support.js";

const admin = {
  manageEventSubscription: () => undefined,
  principal: "test-operator",
  role: "admin",
} as const;
const agent = {
  manageEventSubscription: () => undefined,
  principal: "agent-1",
  role: "agent",
} as const;
const ios = {
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
  requesterId: "agent-1",
} as const;

const daemons: DaemonServer[] = [];
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test").catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
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

class NotingDriver extends FakeDriver {
  constructor(
    options: ConstructorParameters<typeof FakeDriver>[0],
    readonly notes: string[],
  ) {
    super(options);
  }

  override async reclaim(...args: Parameters<FakeDriver["reclaim"]>) {
    this.notes.push("driver reclaim");
    return super.reclaim(...args);
  }

  async dispose(): Promise<void> {
    this.notes.push("driver dispose");
  }
}

interface Rig {
  readonly daemon: DaemonServer;
  readonly clock: FakeClock;
  readonly sink: MemoryLogSink;
  readonly directory: string;
  readonly notes: string[];
  readonly origin: string | undefined;
  readonly driver: NotingDriver;
}

interface RigOptions {
  readonly modules: readonly OptionalModuleDefinition<unknown>[];
  readonly on?: readonly string[];
  readonly http?: boolean;
  // why: agent-device's allocate names no model, so the driver must list a default phone for it.
  readonly phones?: boolean;
  readonly extra?: Partial<StartDaemonOptions>;
  readonly overrides?: Record<string, unknown>;
  readonly notes?: string[];
}

function definitions(...modules: FakeModule[]): OptionalModuleDefinition<unknown>[] {
  return modules.map((module) => module.definition as OptionalModuleDefinition<unknown>);
}

async function prepare(options: RigOptions) {
  const directory = await mkdtemp(join(tmpdir(), "simlock-modules-"));
  directories.push(directory);
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const notes = options.notes ?? [];
  const driver = new NotingDriver(
    {
      availableOsVersions: ["26.5"],
      clock,
      platform: "ios",
      ...(options.phones === true
        ? {
            defaultModels: { phone: ["iPhone 16"] },
            knownModels: ["iPhone 16"],
            modelClasses: { "iPhone 16": "phone" as const },
          }
        : {}),
    },
    notes,
  );
  const port = options.http === true ? await freeLoopbackPort() : undefined;
  const startOptions = {
    clock,
    configOverrides: {
      capabilities: Object.fromEntries((options.on ?? []).map((name) => [name, { enabled: true }])),
      ...(port === undefined ? {} : { http: { enabled: true, host: "127.0.0.1", port } }),
      ...options.overrides,
    },
    dataDirectory: directory,
    drivers: [driver],
    filesystem: new MemoryFilesystem(),
    hostLoadProbe: null,
    logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    optionalModules: options.modules,
    socketPath: join(directory, "daemon.sock"),
    statePath: join(directory, "state.json"),
    version: "1.2.3",
    ...options.extra,
  } as StartDaemonOptions;
  return {
    clock,
    directory,
    driver,
    notes,
    origin: port === undefined ? undefined : `http://127.0.0.1:${String(port)}`,
    sink,
    startOptions,
  };
}

async function start(options: RigOptions): Promise<Rig> {
  const prepared = await prepare(options);
  const daemon = await startDaemon(prepared.startOptions);
  daemons.push(daemon);
  return { ...prepared, daemon };
}

async function agentHeaders(daemon: DaemonServer): Promise<Record<string, string>> {
  const { secret } = await daemon.dispatch("token.create", { label: "a", role: "agent" }, admin);
  return { authorization: `Bearer ${secret}` };
}

async function capabilities(daemon: DaemonServer) {
  const status = (await daemon.dispatch("status.get", {}, agent)) as {
    readonly capabilities?: readonly { name: string; state: string; reason?: string }[];
  };
  return status.capabilities ?? [];
}

function recordsOf(sink: MemoryLogSink, message: string) {
  return sink.records.filter((record) => record.message === message);
}

async function leaseAndRelease(daemon: DaemonServer): Promise<string> {
  const grant = (await daemon.dispatch("lease.request", ios, agent)) as { lease: { id: string } };
  await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);
  return grant.lease.id;
}

// why: a value no default uses, so a timer with it is the lease-end wait ceiling a participant arms.
const END_WAIT_MS = 7_777;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("optional modules: turning on", () => {
  it("a module with no capabilities section, or with enabled false, is reported off in status.get, and its loadWorker is never called", async () => {
    const bare = fakeModule({ name: "alpha" });
    const disabled = fakeModule({ name: "bravo" });
    const { daemon } = await start({
      modules: definitions(bare, disabled),
      overrides: { capabilities: { bravo: { enabled: false } } },
    });

    expect(await capabilities(daemon)).toEqual(
      expect.arrayContaining([
        { name: "alpha", state: "off" },
        { name: "bravo", state: "off" },
      ]),
    );
    expect({ alpha: bare.loads, bravo: disabled.loads }).toEqual({ alpha: 0, bravo: 0 });
  });

  it("a module turned on is loaded once and reports the state its capability source answers", async () => {
    const module = fakeModule({ name: "alpha", state: "unavailable" });
    const { daemon } = await start({ modules: definitions(module), on: ["alpha"] });

    expect(await capabilities(daemon)).toContainEqual(
      expect.objectContaining({ name: "alpha", state: "unavailable" }),
    );
    expect({ loads: module.loads, creates: module.creates }).toEqual({ creates: 1, loads: 1 });
  });

  it("the capability list follows registry order, with agent-device as a registered module", async () => {
    const { daemon } = await start({
      modules: [
        ...definitions(fakeModule({ name: "zulu" })),
        agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
        ...definitions(fakeModule({ name: "alpha" })),
      ],
      on: ["zulu", "agent-device", "alpha"],
    });

    expect((await capabilities(daemon)).map((entry) => entry.name)).toEqual([
      "zulu",
      "agent-device",
      "alpha",
    ]);
  });

  it("config.get returns capabilities with each module's section", async () => {
    const { daemon } = await start({
      modules: definitions(fakeModule({ name: "alpha" })),
      on: ["alpha"],
    });

    const config = (await daemon.dispatch("config.get", {}, admin)) as {
      readonly capabilities?: unknown;
    };

    expect(config.capabilities).toEqual({ alpha: { enabled: true, greeting: "hello" } });
  });
});

describe("optional modules: HTTP routes", () => {
  const handler = (request: Request, identity: { readonly role: string }) =>
    Promise.resolve(Response.json({ path: new URL(request.url).pathname, role: identity.role }));

  it("a module turned on serves /v1/<name> and /v1/<name>/* through its handler, behind agent auth", async () => {
    const { daemon, origin } = await start({
      http: true,
      modules: definitions(fakeModule({ mount: () => handler, name: "alpha" })),
      on: ["alpha"],
    });
    const headers = await agentHeaders(daemon);

    const root = await fetch(`${origin}/v1/alpha`, { headers });
    const deep = await fetch(`${origin}/v1/alpha/deep/x`, { headers });
    const anonymous = await fetch(`${origin}/v1/alpha`);

    expect(await root.json()).toEqual({ path: "/v1/alpha", role: "agent" });
    expect(await deep.json()).toEqual({ path: "/v1/alpha/deep/x", role: "agent" });
    expect(anonymous.status).toBe(401);
  });

  it("a module named like a core route's first segment (status) fails the start, with HTTP off too", async () => {
    const accepted = await start({ modules: definitions(fakeModule({ name: "stats" })) });
    expect(accepted.daemon).toBeDefined();

    await expect(start({ modules: definitions(fakeModule({ name: "status" })) })).rejects.toThrow(
      "status",
    );
  });

  it("with agent-device on and a fake module registered, both modules' routes and relay targets answer, and both capabilities are listed", async () => {
    const seen: string[] = [];
    const { daemon, origin } = await start({
      http: true,
      modules: [
        agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
        ...definitions(
          fakeModule({
            mount: () => handler,
            name: "alpha",
            relayTarget: (_request, tenant) => {
              seen.push(tenant);
              return Promise.resolve(new Response("alpha"));
            },
          }),
        ),
      ],
      on: ["agent-device", "alpha"],
    });
    const headers = await agentHeaders(daemon);
    const uplink = await openUplink(daemon);

    const alphaRoute = await fetch(`${origin}/v1/alpha/ping`, { headers });
    const agentDeviceRoute = await fetch(`${origin}/v1/agent-device/health`, { headers });
    const alphaRelay = await openRelay(uplink, relayInput({ target: "alpha" }));
    const agentDeviceRelay = await settleWithin(
      (await openRelay(uplink, relayInput({ target: "agent-device" }))).result,
    );
    const nobodyRelay = await settleWithin(
      (await openRelay(uplink, relayInput({ target: "nobody" }))).result,
    );

    expect([alphaRoute.status, agentDeviceRoute.status]).toEqual([200, 200]);
    expect(seen).toEqual(["gw.g1.alice"]);
    expect((await alphaRelay.body()).state).toBe("fulfilled");
    expect(nobodyRelay).toMatchObject({ code: "RELAY_TARGET_MISSING", state: "rejected" });
    expect(agentDeviceRelay).not.toMatchObject({ code: "RELAY_TARGET_MISSING" });
    expect((await capabilities(daemon)).map((entry) => entry.name)).toEqual([
      "agent-device",
      "alpha",
    ]);
  });
});

describe("optional modules: relay targets", () => {
  it("a relay request to a module's name reaches its relay target with the tenant and lease id", async () => {
    const calls: { tenant: string; leaseId: string | undefined }[] = [];
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          name: "alpha",
          relayTarget: (_request, tenant, leaseId) => {
            calls.push({ leaseId, tenant });
            return Promise.resolve(new Response("from alpha"));
          },
        }),
      ),
      on: ["alpha"],
    });
    const uplink = await openUplink(daemon);

    const relay = await openRelay(
      uplink,
      relayInput({ leaseId: "lease-9", target: "alpha", tenant: "gw.g1.bob" }),
    );
    const body = await relay.body();

    expect(calls).toEqual([{ leaseId: "lease-9", tenant: "gw.g1.bob" }]);
    expect(body.state === "fulfilled" ? Buffer.from(body.value).toString() : body.state).toBe(
      "from alpha",
    );
  });

  it("a test's relayTargets option still wins over a module's relay target", async () => {
    const { daemon } = await start({
      extra: { relayTargets: { alpha: () => Promise.resolve(new Response("from the test")) } },
      modules: definitions(
        fakeModule({
          name: "alpha",
          relayTarget: () => Promise.resolve(new Response("from alpha")),
        }),
      ),
      on: ["alpha"],
    });
    const uplink = await openUplink(daemon);

    const body = await (await openRelay(uplink, relayInput({ target: "alpha" }))).body();

    expect(body.state === "fulfilled" ? Buffer.from(body.value).toString() : body.state).toBe(
      "from the test",
    );
  });
});

describe("optional modules: doctor findings", () => {
  it("a fake module's finding reaches doctor.run as module-unavailable with module, message and remedy; a second module whose findings() throws loses only its own", async () => {
    const { daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          findings: () => [{ message: "it is down", remedy: "bring it up" }],
          name: "alpha",
        }),
        fakeModule({
          findings: () => {
            throw new Error("boom");
          },
          name: "bravo",
        }),
      ),
      on: ["alpha", "bravo"],
    });

    const report = (await daemon.dispatch("doctor.run", {}, admin)) as {
      readonly findings: readonly { readonly kind: string }[];
    };

    expect(report.findings).toContainEqual({
      kind: "module-unavailable",
      message: "it is down",
      module: "alpha",
      remedy: "bring it up",
    });
    expect(report.findings.filter((finding) => finding.kind === "module-unavailable")).toHaveLength(
      1,
    );
    expect(
      recordsOf(sink, "Could not read optional module findings").map((record) => record.fields),
    ).toEqual([{ message: "boom", module: "bravo" }]);
  });

  it("a module whose findings() throws, reads, then throws again is warned once per run of failures, not once per read", async () => {
    const steps = ["throw", "throw", "read", "throw", "throw"];
    const { daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          findings: () => {
            if (steps.shift() === "throw") throw new Error("boom");
            return [];
          },
          name: "alpha",
        }),
      ),
      on: ["alpha"],
    });
    const startupWarnings = recordsOf(sink, "Could not read optional module findings").length;

    for (let run = 0; run < 5 - startupWarnings; run += 1) {
      await daemon.dispatch("doctor.run", {}, admin);
    }

    expect(recordsOf(sink, "Could not read optional module findings")).toHaveLength(2);
  });
});

describe("optional modules: a start that cannot go on", () => {
  const cases: readonly {
    readonly title: string;
    readonly good: () => FakeModule[];
    readonly bad: () => FakeModule[];
    readonly names: readonly string[];
    readonly overrides?: Record<string, unknown>;
  }[] = [
    {
      bad: () => [fakeModule({ capabilityName: "beta", name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" })],
      names: ["alpha", "beta"],
      title: "a capability name that differs from the definition's",
    },
    {
      bad: () => [fakeModule({ name: "alpha" }), fakeModule({ name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" }), fakeModule({ name: "bravo" })],
      names: ["alpha"],
      title: "two definitions with one name",
    },
    {
      bad: () => [fakeModule({ name: "agent-device" }), fakeModule({ name: "agent-device" })],
      good: () => [fakeModule({ name: "agent-device" }), fakeModule({ name: "agent-devices" })],
      names: ["agent-device"],
      title: "two definitions named agent-device",
    },
    {
      bad: () => [fakeModule({ name: "Bad_Name" })],
      good: () => [fakeModule({ name: "good-name" })],
      names: ["Bad_Name"],
      title: "a name that fails the capability name check",
    },
    {
      bad: () => Array.from({ length: 17 }, (_, i) => fakeModule({ name: `mod-${String(i)}` })),
      good: () => Array.from({ length: 16 }, (_, i) => fakeModule({ name: `mod-${String(i)}` })),
      names: ["mod-16", "17"],
      title: "17 fake modules (17 capabilities)",
    },
    {
      bad: () => [fakeModule({ loadError: new Error("no such file"), name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" })],
      names: ["alpha", "no such file"],
      title: "a loadWorker() that throws",
    },
  ];

  it.each(cases)("the start fails, naming the module, for $title", async ({ bad, good, names }) => {
    const turnOn = (modules: FakeModule[]) => modules.map((m) => m.definition.name);
    const goodModules = good();
    await start({ modules: definitions(...goodModules), on: turnOn(goodModules) });

    const failure = await start({ modules: definitions(...bad()), on: turnOn(bad()) }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    for (const name of names) expect(failure?.message).toContain(name);
  });

  it("a module that calls ctx.cancelPending in createWorker fails the start, naming the module", async () => {
    const quiet = fakeModule({ name: "alpha" });
    await start({ modules: definitions(quiet), on: ["alpha"] });

    const failure = await start({
      modules: definitions(
        fakeModule({ name: "alpha", onCreate: (ctx) => void ctx.cancelPending("agent-1") }),
      ),
      on: ["alpha"],
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("alpha");
    expect(failure?.message).toContain("leasing is not ready yet");
  });

  it("when the second of two modules throws in createWorker, the first module's afterSocketClaimed never runs", async () => {
    const claimed = vi.fn();
    const first = fakeModule({ hooks: { afterSocketClaimed: claimed }, name: "alpha" });
    const failure = await start({
      modules: definitions(
        first,
        fakeModule({
          name: "bravo",
          onCreate: () => {
            throw new Error("bravo broke");
          },
        }),
      ),
      on: ["alpha", "bravo"],
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    await sleep(50);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("bravo");
    expect({ claimed: claimed.mock.calls.length, created: first.creates }).toEqual({
      claimed: 0,
      created: 1,
    });
  });

  it("when the HTTP gateway fails to bind after the socket is claimed, the daemon stops and each started module's beforeDrain and beforeDriversDispose run", async () => {
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as { port: number };
    const notes: string[] = [];
    const hooks: WorkerHooks = {
      beforeDrain: () => {
        notes.push("drain");
        return Promise.resolve();
      },
      beforeDriversDispose: () => {
        notes.push("dispose");
        return Promise.resolve();
      },
    };

    const outcome = await prepare({
      modules: definitions(fakeModule({ hooks, name: "alpha" })),
      notes,
      on: ["alpha"],
      overrides: { http: { enabled: true, host: "127.0.0.1", port } },
    }).then((prepared) =>
      startDaemon(prepared.startOptions).then(
        () => "started",
        () => "rejected",
      ),
    );
    await vi.waitFor(() => expect(notes).toContain("dispose"));

    expect(outcome).toBe("rejected");
    expect(notes.filter((note) => note === "drain" || note === "dispose")).toEqual([
      "drain",
      "dispose",
    ]);
  });
});

describe("optional modules: the context a module receives", () => {
  it("has a logger named after the module, and events.subscribe delivers a bus event", async () => {
    const delivered: string[] = [];
    const seen: { config?: unknown } = {};
    const { daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          name: "alpha",
          onCreate: (ctx) => {
            seen.config = ctx.config;
            ctx.logger.info("alpha says hello");
            ctx.events.subscribe("lease.released", (envelope) => {
              delivered.push(envelope.payload.leaseId);
            });
          },
        }),
      ),
      on: ["alpha"],
    });

    const leaseId = await leaseAndRelease(daemon);

    expect(recordsOf(sink, "alpha says hello").map((record) => record.module)).toEqual([
      "daemon.alpha",
    ]);
    expect(delivered).toEqual([leaseId]);
    expect(seen.config).toEqual({ greeting: "hello" });
  });
});

describe("optional modules: afterSocketClaimed", () => {
  it("runs once after the socket is claimed, and the start does not wait for it", async () => {
    let socketPath = "";
    const seen: boolean[] = [];
    const never = new Promise<void>(() => undefined);
    const prepared = await prepare({
      modules: definitions(
        fakeModule({
          hooks: {
            afterSocketClaimed: () => {
              seen.push(existsSync(socketPath));
              return never;
            },
          },
          name: "alpha",
        }),
      ),
      on: ["alpha"],
    });
    socketPath = join(prepared.directory, "daemon.sock");

    const started = await settleWithin(startDaemon(prepared.startOptions), 5_000);
    if (started.state === "fulfilled") daemons.push(started.value);
    await sleep(50);

    expect(started.state).toBe("fulfilled");
    expect(seen).toEqual([true]);
  });

  it("never runs in a daemon that lost the socket race", async () => {
    const claimed = vi.fn();
    const filesystem = new MemoryFilesystem();
    const directory = await mkdtemp(join(tmpdir(), "simlock-modules-race-"));
    directories.push(directory);
    const options = (modules: readonly OptionalModuleDefinition<unknown>[]) =>
      ({
        clock: new FakeClock(1_000),
        configOverrides: { capabilities: { alpha: { enabled: true } } },
        dataDirectory: directory,
        drivers: [
          new FakeDriver({
            availableOsVersions: ["26.5"],
            clock: new FakeClock(1_000),
            platform: "ios",
          }),
        ],
        filesystem,
        logger: new JsonLinesLogger({
          clock: new FakeClock(1_000),
          level: "debug",
          sink: new MemoryLogSink(),
        }),
        optionalModules: modules,
        statePath: join(directory, "state.json"),
        version: "1.2.3",
      }) as StartDaemonOptions;
    const first = await startDaemon(options([]));
    daemons.push(first);

    const loser = fakeModule({ hooks: { afterSocketClaimed: claimed }, name: "alpha" });
    const second = await startDaemon(options(definitions(loser))).then(
      () => "started",
      () => "rejected",
    );
    await sleep(50);

    expect({ claimed: claimed.mock.calls.length, created: loser.creates, second }).toEqual({
      claimed: 0,
      created: 1,
      second: "rejected",
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("hook broke");
      },
    ],
    ["rejects", () => Promise.reject(new Error("hook broke"))],
  ] as const)(
    "an afterSocketClaimed that %s is logged as failed, and the daemon still starts",
    async (_how, hook) => {
      const { sink } = await start({
        modules: definitions(fakeModule({ hooks: { afterSocketClaimed: hook }, name: "alpha" })),
        on: ["alpha"],
      });

      await vi.waitFor(() =>
        expect(
          recordsOf(sink, "Optional module hook failed").map((record) => record.fields),
        ).toEqual([{ hook: "afterSocketClaimed", message: "hook broke", module: "alpha" }]),
      );
    },
  );
});

describe("optional modules: beforeDeviceReclaim", () => {
  it("a release reclaims the device when no turned-on module has beforeDeviceReclaim", async () => {
    const notes: string[] = [];
    const { clock, daemon } = await start({
      modules: definitions(fakeModule({ name: "alpha" })),
      notes,
      on: ["alpha"],
      overrides: { lease: { endWaitMs: END_WAIT_MS } },
    });

    const timers = vi.spyOn(clock, "setTimer");

    await leaseAndRelease(daemon);

    await vi.waitFor(() => expect(notes).toContain("driver reclaim"));
    expect(timers.mock.calls.map(([delay]) => delay)).not.toContain(END_WAIT_MS);
  });

  it("beforeDeviceReclaim runs after a release commits and before the device's reclaim starts", async () => {
    const notes: string[] = [];
    let live: DaemonServer | undefined;
    const { clock, daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDeviceReclaim: async (lease) => {
              const listed = (await live?.dispatch("lease.list", {}, admin)) as {
                leases: { id: string }[];
              };
              notes.push(
                listed.leases.some((entry) => entry.id === lease.leaseId)
                  ? "lease still listed"
                  : "lease gone",
              );
              await sleep(30);
              notes.push("hook done");
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
      overrides: { lease: { endWaitMs: END_WAIT_MS } },
    });
    live = daemon;
    const timers = vi.spyOn(clock, "setTimer");

    await leaseAndRelease(daemon);
    await vi.waitFor(() => expect(notes).toContain("driver reclaim"));

    expect(notes).toEqual(["lease gone", "hook done", "driver reclaim"]);
    expect(timers.mock.calls.map(([delay]) => delay)).toContain(END_WAIT_MS);
  });
});

describe("optional modules: stop hooks", () => {
  it("beforeDrain finishes before the HTTP gateway stops and before leasing's settle starts", async () => {
    let origin: string | undefined;
    let moduleLog: { info(message: string): void } | undefined;
    const notes: string[] = [];
    const rig = await start({
      http: true,
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDrain: async () => {
              await sleep(50);
              const health = await fetch(`${origin}/v1/healthz`).then(
                (response) => String(response.status),
                () => "refused",
              );
              notes.push(`gateway ${health}`);
              moduleLog?.info("drain done");
            },
          },
          name: "alpha",
          onCreate: (ctx) => {
            moduleLog = ctx.logger;
          },
        }),
      ),
      on: ["alpha"],
    });
    origin = rig.origin;

    await rig.daemon.stop("test");

    const messages = rig.sink.records.map((record) => record.message);
    expect(notes).toEqual(["gateway 200"]);
    expect(messages.indexOf("drain done")).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf("drain done")).toBeLessThan(messages.indexOf("Daemon stopping"));
  });

  it("by the time the stop ends, agent-device's waiting allocate is cancelled through leasing and another module's beforeDrain has run", async () => {
    const drainRan: boolean[] = [];
    let directory = "";
    const rig = await start({
      http: true,
      modules: [
        agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
        ...definitions(
          fakeModule({
            hooks: {
              beforeDrain: async () => {
                drainRan.push(true);
              },
            },
            name: "alpha",
          }),
        ),
      ],
      on: ["agent-device", "alpha"],
      phones: true,
      overrides: {
        capacity: { config: { maxRunning: 1 }, strategy: "fixed" },
      },
    });
    directory = rig.directory;
    const headers = await agentHeaders(rig.daemon);
    await rig.daemon.dispatch("lease.request", ios, agent);
    const allocate = fetch(`${rig.origin}/v1/agent-device/rpc`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "agent_device.lease.allocate",
        params: {
          clientId: "client-1",
          leaseId: "2".padStart(32, "0"),
          leaseProvider: "proxy",
          platform: "ios",
          runId: "run-1",
          ttlMs: 120_000,
        },
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    }).catch(() => undefined);
    await vi.waitFor(async () =>
      expect(
        ((await rig.daemon.dispatch("list.get", { kind: "requests" }, admin)) as unknown[]).length,
      ).toBe(1),
    );

    await rig.daemon.stop("test");
    await allocate;

    const history = await readFile(join(directory, "events.jsonl"), "utf8");
    const cancelled = history
      .split("\n")
      .filter((line) => line.includes('"lease.rejected"') && line.includes('"cancelled"'));
    expect(drainRan).toEqual([true]);
    expect(cancelled).toHaveLength(1);
  });

  it("beforeDriversDispose finishes before any driver's dispose starts", async () => {
    const notes: string[] = [];
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDriversDispose: async () => {
              await sleep(30);
              notes.push("hook done");
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    await daemon.stop("test");

    expect(notes).toEqual(["hook done", "driver dispose"]);
  });

  it("with two modules whose beforeDrain hangs and settles at once, both start together; on a fake clock the step ends at 30 s with only the hanging one logged as ran out of time, and the stop goes on", async () => {
    const started: string[] = [];
    const { clock, daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDrain: () => {
              started.push("hangs");
              return new Promise<void>(() => undefined);
            },
          },
          name: "hangs",
        }),
        fakeModule({
          hooks: {
            beforeDrain: () => {
              started.push("quick");
              return Promise.resolve();
            },
          },
          name: "quick",
        }),
      ),
      on: ["hangs", "quick"],
    });
    let stopped = false;

    const stopping = daemon.stop("test").then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect([...started].sort()).toEqual(["hangs", "quick"]));
    clock.advance(29_999);
    await sleep(30);
    const stoppedEarly = stopped;
    clock.advance(1);
    await stopping;

    expect(stoppedEarly).toBe(false);
    expect(
      recordsOf(sink, "Optional module hook ran out of time").map((record) => record.fields),
    ).toEqual([{ hook: "beforeDrain", module: "hangs" }]);
  });

  it("a beforeDrain that throws is logged as failed, and the HTTP gateway still stops", async () => {
    const { daemon, origin, sink } = await start({
      http: true,
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDrain: () => Promise.reject(new Error("drain broke")),
          },
          name: "alpha",
        }),
      ),
      on: ["alpha"],
    });
    expect((await fetch(`${origin}/v1/healthz`)).status).toBe(200);

    await daemon.stop("test");
    const afterStop = await fetch(`${origin}/v1/healthz`).then(
      () => "answered",
      () => "refused",
    );

    expect(recordsOf(sink, "Optional module hook failed").map((record) => record.fields)).toEqual([
      { hook: "beforeDrain", message: "drain broke", module: "alpha" },
    ]);
    expect(afterStop).toBe("refused");
  });

  it("a beforeDriversDispose that throws is logged, and the drivers are still disposed", async () => {
    const notes: string[] = [];
    const { daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          hooks: { beforeDriversDispose: () => Promise.reject(new Error("dispose broke")) },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    await daemon.stop("test");

    expect(recordsOf(sink, "Optional module hook failed").map((record) => record.fields)).toEqual([
      { hook: "beforeDriversDispose", message: "dispose broke", module: "alpha" },
    ]);
    expect(notes).toContain("driver dispose");
  });

  it("a beforeDriversDispose that runs past 30 s on a fake clock is logged, and the drivers are still disposed", async () => {
    const notes: string[] = [];
    const { clock, daemon, sink } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDriversDispose: () => {
              notes.push("hook started");
              return new Promise<void>(() => undefined);
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    const stopping = daemon.stop("test");
    await vi.waitFor(() => expect(notes).toContain("hook started"));
    clock.advance(30_000);
    await stopping;

    expect(
      recordsOf(sink, "Optional module hook ran out of time").map((record) => record.fields),
    ).toEqual([{ hook: "beforeDriversDispose", module: "alpha" }]);
    expect(notes).toContain("driver dispose");
  });
});
