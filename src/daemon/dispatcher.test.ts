import { describe, expect, it, vi } from "vitest";
import { NoCapacityError } from "../core/lease-acquisition-coordinator.js";
import { testComponentWiring } from "../core/test-wiring.js";

import { EventBus, type EventEnvelope, EventHistory } from "../bus/index.js";
import {
  CleanupReaper,
  ComponentInstaller,
  type Config,
  DiskSpaceGuard,
  Doctor,
  DriverCatalog,
  FakeDriver,
  type HostFacts,
  HostFactsReader,
  LeaseEngine,
  Nuke,
  PassthroughRefusedError,
  Registry,
  SerializedDecision,
  RuntimeMissingError,
} from "../core/index.js";
import {
  OPERATIONS,
  statusDeviceSchema,
  WORKER_VIEW_CATALOG_EVENTS,
  WORKER_VIEW_REFRESH_INTERVAL_MS,
} from "../contract/index.js";
import type { FakeDriverOptions } from "../core/fake-driver.js";
import type { CatalogReader, PassthroughResolver } from "../core/lease-ports.js";
import {
  CryptoTokenSecrets,
  ExecOutputDeliveryStalledError,
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  NodeProcessRunner,
  NoopLogger,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../ports/index.js";
import { TokenStore } from "../http/token-store.js";
import type { DispatchSession } from "./dispatcher.js";
import { Dispatcher, DispatchError } from "./dispatcher.js";
import { classifyError } from "./error-code.js";

const gibibyte = 1024 ** 3;
const HOST_SYSTEM = { arch: "arm64", os: "macOS", osVersion: "15.5" };

/**
 * ADR 0003 §12: "full contract coverage at the dispatcher: one suite ... against a fake driver
 * and a scripted session, covering parsing, role rejection, ownership, and error codes." This
 * suite drives `Dispatcher` directly -- no socket, no `DaemonServer` -- against a real
 * `LeaseEngine`/`Registry`/`CleanupReaper` backed by `FakeDriver`, the same harness style
 * `server.test.ts` uses for its own socket-level tests. It deliberately does not re-walk every
 * operation the way `server.test.ts` already does at the framing/connection level (ADR §12:
 * "re-walking every operation through each transport would test nothing new") -- this suite is
 * where the actual role/ownership/parsing logic gets proven once, not per transport.
 */
/** Picks `buildDispatcher`'s `passthrough` dependency -- a caller-supplied override, or the
 * engine, exactly as every other `overrides.x ?? y` default in that function does. Pulled out
 * on its own so adding this one override does not push `buildDispatcher` itself over fallow's
 * complexity threshold: the branch is real either way, but it belongs to a one-line function
 * that cannot get any more complicated, not to the 130-line one already carrying a dozen of
 * these. */
function resolvePassthroughOverride(
  engine: LeaseEngine,
  override: PassthroughResolver | undefined,
): PassthroughResolver {
  return override ?? engine;
}

/** What the stall test reads: a test's own claims or the engine's, and this driver after any
 * other platforms' a test lists. Pulled out of `buildDispatcher` for the same reason as
 * `resolvePassthroughOverride`. */
function stallOptions(
  engine: LeaseEngine,
  driver: FakeDriver,
  overrides: {
    readonly claims?: { isClaimed(deviceId: string): boolean };
    readonly otherStallDrivers?: readonly FakeDriver[];
  },
) {
  return {
    claims: overrides.claims ?? engine.claimReader,
    drivers: [...(overrides.otherStallDrivers ?? []), driver],
  };
}

function resolveEventHistoryOverride(
  eventBus: EventBus,
  filesystem: MemoryFilesystem,
  override: Pick<EventHistory, "replay"> | undefined,
): Pick<EventHistory, "replay"> {
  return (
    override ??
    new EventHistory({ bus: eventBus, filesystem, logger: new NoopLogger(), path: "/events.jsonl" })
  );
}

/** The fake driver's `simlock <tool>` wrapper, when a test asks for one; nothing otherwise. Pulled
 * out of `buildDispatcher` for the same reason as `resolvePassthroughOverride`. */
function fakePassthroughOptions(
  tool: string | undefined,
  contextSink: unknown[] | undefined,
): Partial<FakeDriverOptions> {
  if (tool === undefined) return {};
  return {
    passthrough: (args: readonly string[], context?: unknown) => {
      contextSink?.push(context);
      // The refusal half of a real driver's passthrough, in the smallest form that
      // proves `device.exec` inherits it: `driver.passthrough` and `device.exec` call
      // this same function, so a verb refused for one is refused for the other.
      if (args.includes("delete")) {
        throw new PassthroughRefusedError(
          tool,
          "Refusing `simlock simctl delete`: use `simlock release` instead.",
        );
      }
      return {
        args: ["--set", "/root", ...args],
        command: tool,
        env: { SIMLOCK_SCOPED: "1" },
      };
    },
    passthroughTool: tool,
  };
}

/** A fake clock that can also be set back, as a wall clock can be. */
class SettableClock extends FakeClock {
  #offset = 0;

  setBack(ms: number): void {
    this.#offset -= ms;
  }

  override now(): number {
    return super.now() + this.#offset;
  }
}

/** `config` with `gateway.label` set, or unchanged when there is no label. */
function withGatewayLabel(config: Config, label: string | undefined): Config {
  return label === undefined ? config : { ...config, gateway: { ...config.gateway, label } };
}

/** `config` with its `http` block replaced, or unchanged when there is none. */
function withHttp(config: Config, http: Config["http"] | undefined): Config {
  return http === undefined ? config : { ...config, http };
}

async function buildDispatcher(
  overrides: {
    readonly downloadsPolicy?: Config["downloads"]["policy"];
    /** Extra fake driver options, such as `knownModels` for a catalog that lists a model. */
    readonly driverOptions?: Partial<FakeDriverOptions>;
    readonly awaitReady?: () => Promise<void>;
    /** Overrides the `catalog` dependency -- used only to force `#parseOutput`'s failure path
     * (see "Dispatcher: #parseOutput") with a fake that returns a payload violating the
     * contract's output schema, something no real `CatalogReader` implementation would do. */
    readonly catalog?: CatalogReader;
    /** ADR §3: `nuke.run` is admin-only and destructive (`safety.md` rules 1/5). `false` by
     * default -- matching `DispatcherOptions.nuke`'s own undefined default, so most tests don't
     * pay for wiring one -- since a real `Nuke` needs this function's own `engine`/`registry`,
     * it is built here (rather than passed in) when a test opts in. */
    readonly includeNuke?: boolean;
    /** Gives the fake driver a `simlock <tool>` wrapper so `driver.passthrough` has something
     * to route to; off by default so no other test's catalog output changes shape. */
    readonly passthroughTool?: string;
    /** Narrows the lease TTL knobs (ADR 0004), for the cap and default-width rules. */
    readonly lease?: Partial<Config["lease"]>;
    /** Wires `device.exec`'s runner (ADR 0005 §19a); absent by default, like the option it
     * feeds, so no other test pays for a scripted process. */
    readonly processRunner?: ProcessRunner;
    /** Narrows `exec.timeoutMs` so the timeout path can be driven with a short clock advance
     * rather than ten minutes of one. */
    readonly exec?: Partial<Config["exec"]>;
    /** Collects the `PassthroughContext` each resolution was given, so a test can assert what
     * the driver was told about its caller (ADR 0005 §19c's "no terminal"). */
    readonly passthroughContextSink?: unknown[];
    /** Shares one clock with the test, for a flow that has to schedule against the dispatcher's
     * own timers. */
    readonly clock?: FakeClock;
    /** Replaces the fake driver's own `passthrough` (which unconditionally prepends
     * `--set /root`) with a caller-supplied resolver -- for the one suite that needs a
     * `device.exec` command a *real* `NodeProcessRunner` can actually spawn (`node -e ...`
     * takes no `--set`), rather than `ScriptedProcessRunner`'s scripted chunks. */
    readonly passthroughOverride?: PassthroughResolver;
    /** Stands in for the event history, so `events.replay` can be checked against it. */
    readonly eventHistory?: Pick<EventHistory, "replay">;
    /** `status.get`'s host block; a fixed machine with no tools by default. */
    readonly hostFacts?: () => HostFacts;
    /** Replaces the capacity block, for a test about one strategy's options. */
    readonly capacity?: Config["capacity"];
    /** Stands in for the component installer: a test that needs to see whether it was reached,
     * or one that reads `status.get`'s installs from an installer of its own. */
    readonly components?: Pick<
      ComponentInstaller,
      "claimProvision" | "inProgress" | "install" | "list" | "remove"
    >;
    /** `gateway.label` in this daemon's config; unset by default. */
    readonly gatewayLabel?: string;
    /** The `http` block; disabled by default. */
    readonly http?: Config["http"];
    /** Stands in for the engine's operation claims in the stall test, so a test can hold one. */
    readonly claims?: { isClaimed(deviceId: string): boolean };
    /** Other platforms' drivers, listed before this one's in the stall test's driver list. */
    readonly otherStallDrivers?: readonly FakeDriver[];
  } = {},
) {
  const clock = overrides.clock ?? new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const filesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    platform: "ios",
    ...overrides.driverOptions,
    ...fakePassthroughOptions(overrides.passthroughTool, overrides.passthroughContextSink),
  });
  const config = withHttp(
    withGatewayLabel(
      testConfig(
        overrides.downloadsPolicy,
        overrides.lease ?? {},
        overrides.exec ?? {},
        overrides.capacity,
      ),
      overrides.gatewayLabel,
    ),
    overrides.http,
  );
  const wiring = testComponentWiring({
    clock: clock,
    components: overrides.components,
    drivers: [driver],
    eventBus: eventBus,
    registry: registry,
  });
  const engine = new LeaseEngine({
    ...wiring,
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const doctor = new Doctor({
    claims: engine.claimReader,
    clock,
    config,
    drivers: [driver],
    eventBus,
    leaseExpirer: engine,
    quarantine: engine,
    registry,
  });
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator: sequence(),
    path: "/tokens.json",
    secrets: new CryptoTokenSecrets(),
  });
  const dispatcher = new Dispatcher({
    awaitReady: overrides.awaitReady ?? (() => Promise.resolve()),
    capacity: engine,
    catalog: overrides.catalog ?? engine,
    clock,
    components: wiring.components,
    config,
    doctor,
    eventBus,
    eventHistory: resolveEventHistoryOverride(eventBus, filesystem, overrides.eventHistory),
    health: () => "running",
    hostFacts: overrides.hostFacts ?? (() => ({ ...HOST_SYSTEM, tools: [] })),
    instanceId: "instance-1",
    leases: engine,
    ...(overrides.includeNuke === true ? { nuke: new Nuke({ executor: engine, registry }) } : {}),
    passthrough: resolvePassthroughOverride(engine, overrides.passthroughOverride),
    ...(overrides.processRunner === undefined ? {} : { processRunner: overrides.processRunner }),
    execEnv: { PATH: "/usr/bin" },
    queue: engine,
    reaper,
    registry,
    stalls: stallOptions(engine, driver, overrides),
    tokens,
    version: "1.2.3",
  });
  return {
    clock,
    components: wiring.components,
    dispatcher,
    doctor,
    driver,
    engine,
    eventBus,
    registry,
    tokens,
  };
}

function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => undefined,
    principal: "tok_agent",
    role: "agent",
    ...overrides,
  };
}

describe("Dispatcher: parsing", () => {
  it("rejects a malformed input with BAD_REQUEST before the handler runs", async () => {
    const { dispatcher } = await buildDispatcher();
    const rejection = dispatcher.dispatch("lease.request", { platform: "ios" }, session());
    await expect(rejection).rejects.toBeInstanceOf(DispatchError);
    await expect(rejection).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each([
    ["android", { emulator: { headless: true } }],
    ["emulator", { headless: true }],
  ])(
    "rejects a lease.request carrying an %s field with BAD_REQUEST: emulator launch options are config-only",
    async (field, value) => {
      const { dispatcher } = await buildDispatcher();
      const valid = { model: "Pixel 8", osVersion: "34", platform: "android" };
      // The same request without the field is well-formed, so the refusal below is about the
      // field and nothing else.
      expect(OPERATIONS["lease.request"].input.safeParse(valid).success).toBe(true);

      await expect(
        dispatcher.dispatch("lease.request", { ...valid, [field]: value }, session()),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it("rejects a ttlMs above lease.maxTtlMs on a request, rather than clamping it, and creates no lease", async () => {
    // ADR 0004 §4: the cap is enforced here rather than in the contract schema, because
    // `lease.maxTtlMs` is a daemon config value the contract module cannot see -- and every
    // transport reaches leases through this one dispatcher, so HTTP inherits the same answer.
    const { dispatcher, registry } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_001 },
        session(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toEqual([]);
  });

  it("rejects a ttlMs above lease.maxTtlMs on a renew too, leaving the lease's deadline as it was", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
      session(),
    );
    // Time has passed, so a renew that went through would have moved the deadline.
    clock.advance(10);

    await expect(
      dispatcher.dispatch("lease.renew", { leaseId: grant.lease.id, ttlMs: 1_001 }, session()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(registry.snapshot.leases).toMatchObject([{ ttlDeadline: grant.lease.ttlDeadline }]);
  });

  it("accepts a ttlMs at the cap on a request (ADR 0004 §4)", async () => {
    const { dispatcher } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
        session(),
      ),
    ).resolves.toMatchObject({ lease: { ttlMs: 1_000 } });
  });

  it("names the stored request to the session on lease.request, and replays it under the same idempotency key", async () => {
    const { dispatcher } = await buildDispatcher();
    const admitted: [string, boolean][] = [];
    const input = { idempotencyKey: "key-1", model: "iPhone 17 Pro", platform: "ios" } as const;
    const track = session({ onRequestAdmitted: (id, replayed) => admitted.push([id, replayed]) });

    const first = await dispatcher.dispatch("lease.request", input, track);
    const repeat = await dispatcher.dispatch("lease.request", input, track);

    expect(repeat.lease.id).toBe(first.lease.id);
    expect(admitted).toEqual([
      [expect.stringMatching(/^req_/), false],
      [admitted[0]?.[0], true],
    ]);
  });

  it("rejects an operation this dispatcher has no handler for with UNKNOWN_REQUEST", async () => {
    const { dispatcher } = await buildDispatcher();
    // "daemon.stop" is ADR §6's frozen exception -- `DaemonServer#dispatchLine` intercepts it
    // before it ever reaches a `Dispatcher`, so this dispatcher genuinely has no handler for it.
    await expect(
      dispatcher.dispatch("daemon.stop", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
  });
});

/**
 * ADR 0012: a worker answers the fleet operations as a fleet of one. `worker.list` is this host's
 * own view; the operations that act on a gateway's workers refuse with their own code.
 */
describe("Dispatcher: the fleet operations on a worker", () => {
  const admin = session({ principal: "operator", role: "admin" });

  it("worker.list on a worker returns one view whose id is the instance id", async () => {
    const { clock, dispatcher } = await buildDispatcher();
    clock.advance(500);

    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      connection: "connected",
      drained: false,
      id: "instance-1",
      lastSeenAt: 1_500,
      version: "1.2.3",
    });
    expect(workers[0]).not.toHaveProperty("protocol");
  });

  it("worker.list on a worker carries gateway.label as label, and no label when it is unset", async () => {
    const labelled = await buildDispatcher({ gatewayLabel: "mac-mini-1" });
    const unlabelled = await buildDispatcher();

    const withLabel = await labelled.dispatcher.dispatch("worker.list", {}, admin);
    const withoutLabel = await unlabelled.dispatcher.dispatch("worker.list", {}, admin);

    expect(withLabel.workers[0]?.label).toBe("mac-mini-1");
    expect(withoutLabel.workers[0]).not.toHaveProperty("label");
  });

  it("worker.list on a worker reads the driver's catalog once per refresh interval, not on every call", async () => {
    const { clock, dispatcher, driver } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");

    // A console polls every second; every poll up to the last millisecond of the interval
    // answers from the one read.
    await dispatcher.dispatch("worker.list", {}, admin);
    for (let elapsed = 1_000; elapsed < WORKER_VIEW_REFRESH_INTERVAL_MS; elapsed += 1_000) {
      clock.advance(1_000);
      await dispatcher.dispatch("worker.list", {}, admin);
    }
    clock.advance(999);
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(2);
  });

  it("worker.list on a worker shares one catalog read between calls that arrive while it runs", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");

    await Promise.all([
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("worker.list", {}, admin),
    ]);

    expect(catalogReads).toHaveBeenCalledTimes(1);
  });

  it("worker.list on a worker reads the catalog again when the clock is set back", async () => {
    const clock = new SettableClock(100_000);
    const { dispatcher, driver } = await buildDispatcher({ clock });
    const catalogReads = vi.spyOn(driver, "listCatalog");
    await dispatcher.dispatch("worker.list", {}, admin);

    clock.setBack(60_000);
    await dispatcher.dispatch("worker.list", {}, admin);

    expect(catalogReads).toHaveBeenCalledTimes(2);
  });

  it("worker.list on a worker re-reads its catalog on each event a gateway re-reads a worker's catalog on, until disposed", async () => {
    const { dispatcher, driver, eventBus } = await buildDispatcher();
    const catalogReads = vi.spyOn(driver, "listCatalog");
    const payload = {
      alreadyPresent: false,
      componentId: "27.0",
      durationMs: 1,
      platform: "ios",
      version: "27.0",
    };
    expect(WORKER_VIEW_CATALOG_EVENTS).toEqual(["component.installed"]);
    await dispatcher.dispatch("worker.list", {}, admin);

    eventBus.emit("component.installed", payload, "test");
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(2);

    dispatcher.dispose();
    await dispatcher.dispatch("worker.list", {}, admin);
    eventBus.emit("component.installed", payload, "test");
    await dispatcher.dispatch("worker.list", {}, admin);
    expect(catalogReads).toHaveBeenCalledTimes(3);
  });

  it("worker.list on a worker lists a runtime installed since its last read, without waiting for the interval", async () => {
    const { components, dispatcher } = await buildDispatcher();
    const runtimes = async () =>
      (await dispatcher.dispatch("worker.list", {}, admin)).workers[0]?.catalog.flatMap(
        (entry) => entry.runtimes,
      );
    expect(await runtimes()).toEqual(["26.5"]);

    await components.install({ component: "27.0", platform: "ios" });

    expect(await runtimes()).toEqual(expect.arrayContaining(["26.5", "27.0"]));
  });

  it("worker.list on a worker reads the catalog again after a read that failed", async () => {
    let calls = 0;
    const { dispatcher } = await buildDispatcher({
      catalog: {
        listCatalog: async () => {
          calls += 1;
          if (calls === 1) throw new Error("the catalog could not be read");
          return [
            {
              defaultRuntime: "26.5",
              modelAliases: {},
              models: [],
              modelRuntimes: {},
              platform: "ios",
              runtimes: ["26.5"],
            },
          ];
        },
      },
    });

    await expect(dispatcher.dispatch("worker.list", {}, admin)).rejects.toThrow(
      "the catalog could not be read",
    );
    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(calls).toBe(2);
    expect(workers[0]?.catalog.flatMap((entry) => entry.runtimes)).toEqual(["26.5"]);
  });

  it("worker.list on a worker reports the same capacity, devices, leases, catalog, host and installs as its own reads", async () => {
    const { components, dispatcher, driver } = await buildDispatcher({
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
      hostFacts: () => ({
        ...HOST_SYSTEM,
        tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
      }),
    });
    // One lease on one device, and one install held mid-download: every field has something
    // in it, so a field the view dropped or took from the wrong read cannot pass as empty.
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", platform: "ios" },
      session(),
    );
    driver.holdInstalls();
    void components.install({ component: "27.0", platform: "ios" });
    await flushPromises();

    const [{ workers }, status, devices, catalog, config] = await Promise.all([
      dispatcher.dispatch("worker.list", {}, admin),
      dispatcher.dispatch("status.get", {}, admin),
      dispatcher.dispatch("list.get", { kind: "devices" }, admin),
      dispatcher.dispatch("catalog.get", {}, admin),
      dispatcher.dispatch("config.get", {}, admin),
    ]);

    expect(status.leases).toHaveLength(1);
    expect(status.installs).toHaveLength(1);
    expect(status.host.tools).toHaveLength(1);
    expect(catalog.platforms[0]?.models).toEqual(["iPhone 17 Pro"]);
    expect(workers[0]).toMatchObject({
      capacity: status.capacity,
      catalog: catalog.platforms,
      devices: statusDeviceSchema.array().parse(devices),
      downloads: { policy: config.downloads.policy, timeoutMs: config.downloads.timeoutMs },
      health: status.daemon.health,
      host: status.host,
      installs: status.installs,
      lease: { maxTtlMs: config.lease.maxTtlMs },
      leases: status.leases,
      queueDepth: status.queueDepth,
    });
    expect(workers[0]?.devices).toHaveLength(1);
    expect(workers[0]?.devices[0]).not.toHaveProperty("driverData");
  });

  it("worker.drain, worker.undrain, worker.remove and worker.install-component on a worker fail with UNSUPPORTED_IN_WORKER_MODE", async () => {
    const { components, dispatcher } = await buildDispatcher();
    const install = vi.spyOn(components, "install");
    const calls = [
      ["worker.drain", { workerId: "instance-1" }],
      ["worker.undrain", { workerId: "instance-1" }],
      ["worker.remove", { workerId: "instance-1" }],
      ["worker.install-component", { platform: "ios", version: "27.0", workers: "all" }],
    ] as const;

    const refusals = await Promise.all(
      calls.map(([operation, input]) =>
        dispatcher.dispatch(operation, input, admin).then(
          () => ({ operation, outcome: "answered" }),
          (error: unknown) => ({ error, operation }),
        ),
      ),
    );

    expect(refusals).toEqual(
      calls.map(([operation]) => ({
        error: expect.objectContaining({
          code: "UNSUPPORTED_IN_WORKER_MODE",
          details: { operation },
        }),
        operation,
      })),
    );
    // The refusal is the whole answer: nothing was installed on this host instead, and the
    // message says how to install here.
    expect(install).not.toHaveBeenCalled();
    expect(String((refusals[3] as { error?: unknown } | undefined)?.error)).toContain(
      "install on this host without naming workers",
    );
  });
});

describe("Dispatcher: token.create | token.list | token.revoke", () => {
  it("creates a token, lists it, then revokes it -- admin only", async () => {
    const { dispatcher, tokens } = await buildDispatcher();
    const admin = session({ role: "admin" });

    await expect(
      dispatcher.dispatch("token.create", { role: "agent" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await dispatcher.dispatch(
      "token.create",
      { role: "operator", label: "ci" },
      admin,
    );
    expect(created.token.role).toBe("operator");
    expect(created.token.label).toBe("ci");
    expect(typeof created.secret).toBe("string");

    const listed = await dispatcher.dispatch("token.list", {}, admin);
    expect(listed.tokens.map((token) => token.id)).toEqual([created.token.id]);

    const revoked = await dispatcher.dispatch("token.revoke", { id: created.token.id }, admin);
    expect(revoked.revoked).toBe(true);
    expect((await tokens.list()).length).toBe(0);
  });

  it("revoking an unknown token id returns revoked: false rather than throwing", async () => {
    const { dispatcher } = await buildDispatcher();
    const result = await dispatcher.dispatch(
      "token.revoke",
      { id: "tok_does-not-exist" },
      session({ role: "admin" }),
    );
    expect(result.revoked).toBe(false);
  });
});

describe("Dispatcher: role rejection", () => {
  it("rejects an admin-only operation from an agent session with FORBIDDEN", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admits the same admin-only operation for an admin session", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
    ).resolves.toEqual([]);
  });

  // Both halves of this shipped broken once: the handler forwarded `fix` alone, so
  // `doctor --purge-orphans` prompted for confirmation and then destroyed nothing. The flag
  // stays its own all the way down -- an unattended `--fix` must not acquire a destructive
  // behaviour by upgrading (ADR 0001, decision 6) -- which is only true if it also *arrives*.
  it("doctor.run forwards purgeOrphans to the Doctor, distinctly from fix, and always asks for prerequisites", async () => {
    const { dispatcher, doctor } = await buildDispatcher();
    const reconcile = vi.spyOn(doctor, "reconcile");

    await dispatcher.dispatch("doctor.run", {}, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: false,
      prerequisites: true,
      purgeOrphans: false,
    });

    await dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: true,
      prerequisites: true,
      purgeOrphans: false,
    });

    await dispatcher.dispatch("doctor.run", { purgeOrphans: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({
      fix: false,
      prerequisites: true,
      purgeOrphans: true,
    });
  });

  // `driver.passthrough` was declared in the contract and dispatched by the socket switch while
  // no handler existed for it, which the partial handler map hid from the compiler: every
  // `simlock simctl` / `simlock adb` answered UNKNOWN_REQUEST. The map is total now, so this
  // guards the routing rather than the registration.
  it("driver.passthrough resolves the scoped command through the driver that claims the tool", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch(
        "driver.passthrough",
        { args: ["list", "devices"], tool: "simctl" },
        session(),
      ),
    ).resolves.toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      env: { SIMLOCK_SCOPED: "1" },
    });
  });

  it("driver.passthrough refuses a tool no driver claims", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch("driver.passthrough", { args: ["devices"], tool: "adb" }, session()),
    ).rejects.toThrow(/No driver provides a adb passthrough/);
  });

  it("doctor.run's role depends on its own input: fix:false is agent, fix:true is admin", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: false }, session({ role: "agent" })),
    ).resolves.toBeDefined();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" })),
    ).resolves.toBeDefined();
  });
});

describe("Dispatcher: ownership", () => {
  async function grantLease(dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"]) {
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    return (grant as { lease: { id: string } }).lease.id;
  }

  it("lease.request: rejects a non-admin session naming owner with FORBIDDEN, never silently ignoring it (ADR §27a, H7)", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", owner: "someone-else", platform: "ios" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // H3 (round 3 review): §27a's gate used to be `role !== "admin"`, which an HTTP `operator`
  // bearer token satisfies just as well as the gateway's own uplink -- on a plain worker with no
  // gateway anywhere, any operator token could name someone else as owner. `isGatewayUplink` is
  // the narrower signal `DaemonServer#session` stamps only for a connection accepted through
  // `acceptUplink` (this worker dialled its own configured `gateway.url`); a session merely
  // carrying `role: "admin"` from anywhere else -- an operator token's HTTP session included --
  // no longer suffices.
  it("lease.request: rejects a plain admin session (not the gateway's uplink) naming owner with FORBIDDEN (ADR §27a, H3)", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", owner: "someone-else", platform: "ios" },
        session({ principal: "tok_operator", role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lease.request: the gateway's own uplink session may set owner, and the granted lease ends up owned by that, not the uplink's own principal (ADR §27a, H3)", async () => {
    const { dispatcher } = await buildDispatcher();

    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", owner: "agent-7", platform: "ios" },
      session({ isGatewayUplink: true, principal: "tok_gateway", role: "admin" }),
    );

    expect((grant as { lease: { ownerId: string } }).lease.ownerId).toBe("agent-7");
    // The lease is now gated on the named owner, not the uplink session that requested it.
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId: (grant as { lease: { id: string } }).lease.id },
        session({ principal: "tok_gateway", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId: (grant as { lease: { id: string } }).lease.id },
        session({ principal: "agent-7", role: "agent" }),
      ),
    ).resolves.toMatchObject({ id: (grant as { lease: { id: string } }).lease.id });
  });

  it("lease.renew: rejects a non-owner with FORBIDDEN, admits the owner, admin bypasses", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.renew", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ id: leaseId });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "admin" }),
      ),
    ).resolves.toMatchObject({ id: leaseId });
  });

  it("lease.release: rejects a non-owner with FORBIDDEN, admits the owner", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.release",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.release", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ leaseId });
  });

  it("lease.list: an agent sees only its own leases, admin sees all", async () => {
    const { dispatcher } = await buildDispatcher();
    await grantLease(dispatcher);

    const own = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_owner", role: "agent" }),
    );
    expect(own.leases).toHaveLength(1);

    const otherAgent = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_other", role: "agent" }),
    );
    expect(otherAgent.leases).toHaveLength(0);

    const admin = await dispatcher.dispatch("lease.list", {}, session({ role: "admin" }));
    expect(admin.leases).toHaveLength(1);
  });

  it("lease.cancel: naming a requesterId with no pending request always passes (not-found), admin bypasses too", async () => {
    const { dispatcher } = await buildDispatcher();

    // A requesterId nobody has a pending request under: not gated, since there is no owner to
    // compare against -- `pendingRequestOwner` resolves `undefined`, and `not-found` is what
    // surfaces (the same convention `ownsLease` uses for an unknown lease id).
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });

    // An omitted requesterId always passes (defaults to the principal) -- see the operation's
    // `authorize` hook doc in `operations.ts`.
    await expect(
      dispatcher.dispatch("lease.cancel", {}, session({ principal: "tok_agent", role: "agent" })),
    ).resolves.toMatchObject({ result: "not-found" });

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_admin", role: "admin" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });
  });

  it("lease.cancel: gated on the pending request's recorded owner (ADR §4), not the requesterId -- so a proxy connection can cancel what it created", async () => {
    const { dispatcher, engine } = await buildDispatcher();

    // Fill iOS capacity (maxRunning: 2, see testConfig) so a third request queues instead of
    // granting immediately -- cancellability requires a still-`queued` waiter.
    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner1",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner1" }),
    );
    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner2",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner2" }),
    );

    // ADR §4's proxy case: one connection, principal "host", requesting under a different
    // requesterId ("agent-7") than its own principal.
    const queuedRequest = dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "agent-7",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "host" }),
    );
    await expect.poll(() => engine.queueDepth).toBe(1);

    // Naming "agent-7" from a session that is neither "host" (the recorded owner) nor admin is
    // FORBIDDEN, even though "agent-7" is the pending request's own requesterId -- the ADR
    // incoherence this fixes: `lease.cancel` is no longer gated on `requesterId === principal`.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The owning principal ("host") cancels what it created, under the requesterId it created
    // it with -- this is the case the old `requesterId === principal` comparison forbade
    // outright.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "host", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "cancelled" });

    await expect(queuedRequest).rejects.toThrow();
  });
});

// Review finding S9: `Dispatcher#leaseReleaseAll` and `#nukeRun` were exercised by no test
// anywhere (`nuke.run` appeared in `server.test.ts` only inside a comment) -- both are
// admin-only and destructive, which is exactly what `docs/internal/agent-rules/safety.md` rules 1
// ("registry-only destruction") and 5 ("destructive CLI commands confirm or require --yes") are
// about. `--yes`/confirmation is a CLI-layer concern (not this dispatcher's), but role
// enforcement and "it actually destroys only what it should" are, and neither had coverage.
describe("Dispatcher: lease.release-all", () => {
  it("rejects an agent session with FORBIDDEN, without releasing anything", async () => {
    const { dispatcher, registry } = await buildDispatcher();
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("lease.release-all", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The lease this agent session doesn't even own must still be untouched -- a rejected
    // `lease.release-all` released nothing, it didn't just fail to report what it released.
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin releases every lease, regardless of owner, and reports every released id", async () => {
    const { dispatcher, eventBus, registry } = await buildDispatcher();
    const first = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_1" }),
    );
    const second = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_2" }),
    );
    expect(registry.snapshot.leases).toHaveLength(2);

    const result = await dispatcher.dispatch(
      "lease.release-all",
      {},
      session({ principal: "tok_admin", role: "admin" }),
    );

    expect(new Set(result.leaseIds)).toEqual(new Set([first.lease.id, second.lease.id]));
    expect(registry.snapshot.leases).toHaveLength(0);
    // `killed`, not `explicit`: nobody's holder asked for this (docs/internal/EVENTS.md), and that is
    // the distinction a `lease-lost` reader acts on.
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.released")
        .map((event) => (event.payload as { reason: string }).reason),
    ).toEqual(["killed", "killed"]);
  });
});

describe("Dispatcher: events.replay", () => {
  it("events.replay with sinceTs returns what the event history returns", async () => {
    const fromHistory: EventEnvelope[] = [
      { seq: 7, timestamp: 50, event: "daemon.stopping", payload: { reason: "x" }, module: "d" },
    ];
    const asked: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      eventHistory: {
        replay: async (input) => {
          asked.push(input);
          return fromHistory;
        },
      },
    });

    await expect(
      dispatcher.dispatch("events.replay", { sinceTs: 10 }, session({ role: "admin" })),
    ).resolves.toEqual(fromHistory);
    expect(asked).toEqual([{ sinceTs: 10 }]);
  });
});

describe("Dispatcher: nuke.run", () => {
  it("rejects an agent session with FORBIDDEN, without deleting anything", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin can run it, releasing every lease and reporting the deleteDevices flag it ran with", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    expect(registry.snapshot.leases).toHaveLength(1);

    const result = await dispatcher.dispatch(
      "nuke.run",
      { deleteDevices: false },
      session({ role: "admin" }),
    );

    expect(result.releasedLeaseIds).toHaveLength(1);
    expect(registry.snapshot.leases).toHaveLength(0);
  });

  it("throws NukeUnavailableError when the dispatcher was built with no Nuke wired -- an admin cannot bypass this", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ name: "NukeUnavailableError" });
  });
});

describe("Dispatcher: device mode on every surface", () => {
  const request = { model: "iPhone 17 Pro", platform: "ios" } as const;

  it.each([
    ["slim", "a slim boot", "slim"],
    ["full", "no mode", undefined],
  ] as const)(
    "a lease grant's device carries mode: %s when the driver reported %s",
    async (expected, _reported, driverMode) => {
      const { dispatcher } = await buildDispatcher({ driverOptions: { mode: driverMode } });

      const grant = await dispatcher.dispatch("lease.request", request, session());

      expect(grant.device.mode).toBe(expected);
    },
  );

  it("status.get and list.get return mode for every device, including one still provisioning", async () => {
    const { dispatcher, registry } = await buildDispatcher({ driverOptions: { mode: "slim" } });
    const granted = await dispatcher.dispatch("lease.request", request, session());
    const provisioning = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver-provisioning",
      provisionDuration: 0,
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    );

    const expected = [
      { id: granted.device.id, mode: "slim" },
      { id: provisioning.id, mode: "full" },
    ];
    expect(status.devices.map(({ id, mode }) => ({ id, mode }))).toEqual(expected);
    expect((list as { id: string; mode: string }[]).map(({ id, mode }) => ({ id, mode }))).toEqual(
      expected,
    );
  });

  it("status marks a stalled device with stalled: true and leaves others without it", async () => {
    const { clock, dispatcher, registry } = await buildDispatcher();
    const leased = await dispatcher.dispatch("lease.request", request, session());
    const register = (driverDeviceId: string) =>
      registry.registerDevice({
        driverData: {},
        driverDeviceId,
        provisionDuration: 0,
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      });
    const stuck = await register("driver-stuck");
    // The fake driver estimates 0, so the threshold is the 60 s floor. The stuck device is past
    // it; the fresh one, provisioning too, is not.
    clock.advance(60_001);
    const fresh = await register("driver-fresh");

    const status = await dispatcher.dispatch("status.get", {}, session());
    const list = (await dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    )) as { id: string; stalled?: boolean }[];
    const { workers } = await dispatcher.dispatch(
      "worker.list",
      {},
      session({ principal: "operator", role: "admin" }),
    );

    for (const devices of [status.devices, list, workers[0]?.devices ?? []]) {
      const byId = new Map(devices.map((device) => [device.id, device]));
      expect(byId.get(stuck.id)?.stalled).toBe(true);
      expect(byId.get(fresh.id)).toBeDefined();
      expect(byId.get(fresh.id)).not.toHaveProperty("stalled");
      expect(byId.get(leased.device.id)).toBeDefined();
      expect(byId.get(leased.device.id)).not.toHaveProperty("stalled");
    }
  });

  it("status leaves stalled off a device past its threshold that a live operation holds", async () => {
    // The same rule as `doctor`: a claim says work is in progress, however long it takes.
    const claimed = new Set<string>();
    const { clock, dispatcher, registry } = await buildDispatcher({
      claims: { isClaimed: (deviceId) => claimed.has(deviceId) },
    });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver-booting",
      provisionDuration: 0,
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);
    const stalled = async () =>
      (await dispatcher.dispatch("status.get", {}, session())).devices.find(
        (entry) => entry.id === device.id,
      )?.stalled;

    claimed.add(device.id);
    expect(await stalled()).toBeUndefined();
    claimed.delete(device.id);
    expect(await stalled()).toBe(true);
  });

  it("status measures a stall against the driver for the device's own platform", async () => {
    // Android's estimate puts its threshold at 30 min; the iOS fake's 0 leaves the 60 s floor.
    const android = new FakeDriver({
      clock: new FakeClock(1_000),
      estimateMs: { boot: 300_000, provision: 300_000 },
      platform: "android",
    });
    const { clock, dispatcher, registry } = await buildDispatcher({ otherStallDrivers: [android] });
    const device = await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver-ios-stuck",
      provisionDuration: 0,
      spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
    });
    clock.advance(60_001);

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.devices.find((entry) => entry.id === device.id)?.stalled).toBe(true);
  });

  it("no lease.request, list.get, or status.get response carries featureProfile or slim", async () => {
    const { dispatcher } = await buildDispatcher({ driverOptions: { mode: "slim" } });

    const responses = [
      await dispatcher.dispatch("lease.request", request, session()),
      await dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
      await dispatcher.dispatch("status.get", {}, session()),
    ];

    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).toContain('"mode":"slim"');
      expect(json).not.toContain('"featureProfile"');
      expect(json).not.toContain('"slim":');
    }
  });
});

describe("Dispatcher: #parseOutput", () => {
  // ADR §1's central claim -- "the daemon maps its own records onto contract types in exactly
  // one place ... this is what keeps private types out of the public package surface" -- names
  // `#parseOutput` as the enforcement mechanism (see `schemas.ts`'s module doc). It had no test
  // of its own failure path: every other dispatcher test exercises a handler whose real output
  // already satisfies its schema, so `#parseOutput`'s `safeParse` always took the success
  // branch. This forces the failure branch with a `catalog: CatalogReader` fake that returns a
  // payload no real `CatalogReader` implementation would -- one that does not satisfy
  // `platformCatalogSchema` -- and checks the dispatcher does not leak that malformed payload
  // out, or the underlying zod issue detail, to the caller.
  it("fails closed with an opaque Internal error when a handler's output violates its contract schema, instead of leaking the malformed payload", async () => {
    const badCatalog: CatalogReader = {
      // `platformCatalogSchema` requires (among other fields) `platform`/`models`/`runtimes` --
      // this satisfies none of them.
      listCatalog: async () => [{ notAValidCatalogEntry: true } as never],
    };
    const { dispatcher } = await buildDispatcher({ catalog: badCatalog });

    await expect(dispatcher.dispatch("catalog.get", {}, session())).rejects.toThrow(
      /does not match its contract output schema/,
    );
    try {
      await dispatcher.dispatch("catalog.get", {}, session());
      expect.unreachable();
    } catch (error: unknown) {
      // Fails closed, generically -- not the raw zod issues (which could describe internal
      // shape) and not the malformed payload itself.
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("notAValidCatalogEntry");
    }
  });
});

describe("Dispatcher: error codes", () => {
  it("lets a domain error (e.g. RUNTIME_MISSING) propagate untouched from the handler", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "99.0", platform: "ios" },
        session(),
      ),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
  });
});

describe("Dispatcher: image tags", () => {
  const androidImages: Partial<FakeDriverOptions> = {
    availableOsVersions: ["34", "35"],
    images: [
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
    ],
    platform: "android",
  };

  it("grants a request naming an installed tag a device whose spec shows the tag, and one naming none a spec without it", async () => {
    // One dispatcher each: the test config's capacity holds one device.
    const tagged = await (
      await buildDispatcher({ driverOptions: androidImages })
    ).dispatcher.dispatch(
      "lease.request",
      {
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
        requesterId: "tagged",
      },
      session(),
    );
    const untagged = await (
      await buildDispatcher({ driverOptions: androidImages })
    ).dispatcher.dispatch(
      "lease.request",
      { model: "Pixel 8", osVersion: "34", platform: "android", requesterId: "untagged" },
      session(),
    );

    expect(tagged.device.spec).toEqual({
      imageTag: "google_apis_playstore",
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
    expect(untagged.device.spec).toEqual({
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
  });

  it("answers RUNTIME_MISSING for a tag not installed for the API level, even with allowDownload under downloads.policy 'always', and starts no install", async () => {
    const asked: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      components: {
        claimProvision: () => () => undefined,
        inProgress: () => [],
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "35" };
        },
        list: async () => [],
        remove: () => Promise.reject(new Error("unreachable")),
      },
      downloadsPolicy: "always",
      driverOptions: androidImages,
    });

    const error = await dispatcher
      .dispatch(
        "lease.request",
        {
          allowDownload: true,
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          osVersion: "35",
          platform: "android",
        },
        session(),
      )
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("RUNTIME_MISSING");
    expect(asked).toEqual([]);
  });

  it.each([
    ["a character outside letters, digits, '_', '.' and '-'", "google apis"],
    ["more than 64 characters", "a".repeat(65)],
    ["no characters", ""],
  ])("refuses a tag with %s as BAD_REQUEST before any driver sees it", async (_label, imageTag) => {
    const { dispatcher, driver } = await buildDispatcher({ driverOptions: androidImages });

    const error = await dispatcher
      .dispatch("lease.request", { imageTag, model: "Pixel 8", platform: "android" }, session())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("BAD_REQUEST");
    expect(driver.calls.map((call) => call.operation)).not.toContain("resolveSpec");
  });
});

describe("Dispatcher: the download policy clamp applies regardless of caller", () => {
  // This is the exact behaviour ADR 0003 §2 says HTTP was missing ("the socket path applies
  // `config.downloads.policy`, HTTP passes `allowDownload` through unclamped"). Since HTTP now
  // calls this same `lease.request` handler (see `src/http/tracker.ts`), proving the clamp
  // here proves it for both frontends -- there is exactly one implementation of it left.
  it("starts no install for allowDownload:true when downloads.policy is 'never'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "never" });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { allowDownload: true, model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
        session(),
      ),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
    expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");
  });

  it("catalog.get does not list an uninstalled runtime under downloads.policy 'always'", async () => {
    // The fake driver has only 26.5 installed; under 'always' any other version is a download
    // away, and the catalog still lists only what is on the machine.
    const { dispatcher, driver } = await buildDispatcher({
      downloadsPolicy: "always",
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
    });

    const catalog = await dispatcher.dispatch("catalog.get", {}, session());

    expect(catalog.platforms).toEqual([
      expect.objectContaining({
        modelRuntimes: { "iPhone 17 Pro": ["26.5"] },
        platform: "ios",
        runtimes: ["26.5"],
      }),
    ]);
    // The policy never reaches the driver, so nothing it could download can leak into the list.
    const listCalls = driver.calls.filter((call) => call.operation === "listCatalog");
    expect(listCalls.map((call) => call.arguments)).toEqual([[]]);
  });

  it("catalog.get keeps a custom model whose name is too long for the mark listed, without the mark, in an answer the contract accepts", async () => {
    const long = "x".repeat(300);
    const { dispatcher } = await buildDispatcher({
      driverOptions: { customModels: [long, "My Tablet"], knownModels: [long, "My Tablet"] },
    });

    const catalog = await dispatcher.dispatch("catalog.get", {}, session());

    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
    expect(catalog.platforms[0]?.models).toEqual([long, "My Tablet"]);
    expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
  });

  it.each(["never", "on-request", "always"] as const)(
    "catalog.get lists exactly the images the driver finds installed under downloads.policy '%s'",
    async (downloadsPolicy) => {
      const installed = [{ abi: "arm64-v8a", runtime: "26.5", tag: "default" }];
      const { dispatcher, driver } = await buildDispatcher({
        downloadsPolicy,
        driverOptions: { images: installed, knownModels: ["iPhone 17 Pro"] },
      });

      const catalog = await dispatcher.dispatch("catalog.get", {}, session());

      expect(catalog.platforms[0]?.images).toEqual(installed);
      // The driver is asked with no policy, so no policy can add an image it would download.
      const listCalls = driver.calls.filter((call) => call.operation === "listCatalog");
      expect(listCalls.map((call) => call.arguments)).toEqual([[]]);
    },
  );

  it("installs for allowDownload:true when downloads.policy is 'on-request'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });
    await dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
      session(),
    );
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["27.0"]]);
  });
});

describe("Dispatcher: status.get installs in progress", () => {
  const installTimeoutMs = 60_000;

  /** A dispatcher whose `status.get` reads a real installer over an iOS fake driver that holds
   * every install until the test releases it. */
  async function withInstaller() {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const installer = new ComponentInstaller({
      clock,
      decisions: new SerializedDecision(),
      diskSpace: new DiskSpaceGuard(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      filesystem: new MemoryFilesystem(),
      registry: {
        deleteComponent: () => Promise.resolve(),
        recordComponent: () => Promise.resolve(),
        snapshot: { components: [], devices: [], leases: [] },
      },
      timeoutMs: installTimeoutMs,
    });
    const { dispatcher } = await buildDispatcher({ clock, components: installer });
    const installs = async () => (await dispatcher.dispatch("status.get", {}, session())).installs;
    return { clock, driver, installer, installs };
  }

  it("lists a running install as downloading and one behind it on the same platform as waiting", async () => {
    const { clock, installer, installs } = await withInstaller();

    void installer.install({ component: "27.0", platform: "ios" });
    await flushPromises();
    clock.advance(2_000);
    void installer.install({ component: "28.0", platform: "ios" });
    await flushPromises();

    expect(await installs()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 1 },
      { component: "28.0", platform: "ios", since: 3_000, state: "waiting", waiters: 1 },
    ]);
  });

  it("lists an install three calls joined once, with waiters: 3", async () => {
    const { installer, installs } = await withInstaller();

    for (let call = 0; call < 3; call += 1) {
      void installer.install({ component: "27.0", platform: "ios" });
    }
    await flushPromises();

    expect(await installs()).toEqual([
      { component: "27.0", platform: "ios", since: 1_000, state: "downloading", waiters: 3 },
    ]);
  });

  it("lists no install once it has succeeded", async () => {
    const { driver, installer, installs } = await withInstaller();
    const call = installer.install({ component: "27.0", platform: "ios" });
    await flushPromises();
    expect(await installs()).toHaveLength(1);

    driver.releaseInstalls();
    await call;

    expect(await installs()).toEqual([]);
  });

  it("lists no install once it has failed", async () => {
    const { driver, installer, installs } = await withInstaller();
    driver.releaseInstalls();
    driver.failOn("installComponent", 1, new Error("installer exited 1"));
    const call = installer.install({ component: "27.0", platform: "ios" });
    // Listed from the moment it is asked for, before the driver has run.
    expect(installer.inProgress()).toHaveLength(1);

    await expect(call).rejects.toThrow("installer exited 1");
    expect(await installs()).toEqual([]);
  });

  it("lists no install once it has timed out, running or still waiting", async () => {
    const { clock, installer, installs } = await withInstaller();
    const running = installer.install({ component: "27.0", platform: "ios" });
    const waiting = installer.install({ component: "28.0", platform: "ios" });
    await flushPromises();
    expect(await installs()).toHaveLength(2);

    clock.advance(installTimeoutMs);
    await expect(running).rejects.toMatchObject({ name: "ComponentInstallTimeoutError" });
    await expect(waiting).rejects.toMatchObject({ name: "ComponentInstallTimeoutError" });

    expect(await installs()).toEqual([]);
  });

  it("answers an empty list when nothing is installing", async () => {
    const { installs } = await withInstaller();

    expect(await installs()).toEqual([]);
  });
});

describe("Dispatcher: list.get requests and status.get waiting", () => {
  const IOS_REQUEST = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;

  /** A lease request from `requesterId`, left running: it resolves once granted. */
  function request(
    dispatcher: Dispatcher,
    requesterId: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    return dispatcher.dispatch(
      "lease.request",
      { ...IOS_REQUEST, requesterId, ...extra },
      session({ principal: "host" }),
    );
  }

  /** Fills iOS's two devices (`testConfig`), so the next request queues. */
  async function fillIos(dispatcher: Dispatcher): Promise<void> {
    await request(dispatcher, "holder-1");
    await request(dispatcher, "holder-2");
  }

  const requests = (dispatcher: Dispatcher) =>
    dispatcher.dispatch("list.get", { kind: "requests" }, session({ role: "admin" }));

  it("list.get requests on a worker returns every open request with its queue position", async () => {
    const { clock, dispatcher, engine } = await buildDispatcher();
    await fillIos(dispatcher);
    const firstAt = clock.now();
    void request(dispatcher, "agent-a", { idempotencyKey: "key-a", mode: "full" });
    await expect.poll(() => engine.queueDepth).toBe(1);
    clock.advance(5_000);
    void request(dispatcher, "agent-b");
    await expect.poll(() => engine.queueDepth).toBe(2);

    const listed = await requests(dispatcher);

    expect(listed).toEqual([
      {
        createdAt: firstAt,
        id: expect.any(String),
        queuePosition: 1,
        requesterId: "agent-a",
        spec: { ...IOS_REQUEST, mode: "full" },
        stage: "queued",
      },
      {
        createdAt: firstAt + 5_000,
        id: expect.any(String),
        queuePosition: 2,
        requesterId: "agent-b",
        spec: IOS_REQUEST,
        stage: "queued",
      },
    ]);
    // The idempotency key and the owner stay the requester's.
    expect(JSON.stringify(listed)).not.toContain("key-a");
    expect(JSON.stringify(listed)).not.toContain('"host"');
  });

  it("a request that is starting a device has stage starting and no queue position", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: { latencyMs: { provision: 60_000 } },
    });
    void request(dispatcher, "agent-a");

    await expect.poll(async () => (await requests(dispatcher)).length).toBe(1);

    expect(await requests(dispatcher)).toEqual([
      {
        createdAt: expect.any(Number),
        id: expect.any(String),
        requesterId: "agent-a",
        spec: IOS_REQUEST,
        stage: "starting",
      },
    ]);
  });

  it("a granted, failed or cancelled request is not listed", async () => {
    const { clock, dispatcher, engine, registry } = await buildDispatcher();
    await fillIos(dispatcher);
    const timedOut = request(dispatcher, "agent-timeout", { timeoutMs: 1_000 });
    const cancelled = request(dispatcher, "agent-cancel");
    await expect.poll(() => engine.queueDepth).toBe(2);
    expect(await requests(dispatcher)).toHaveLength(2);

    clock.advance(1_000);
    await expect(timedOut).rejects.toMatchObject({ name: "QueueTimeoutError" });
    await dispatcher.dispatch(
      "lease.cancel",
      { requesterId: "agent-cancel" },
      session({ principal: "host" }),
    );
    await expect(cancelled).rejects.toThrow();

    await expect
      .poll(() => registry.leaseRequests().map((record) => record.state))
      .toEqual(["granted", "granted", "failed", "cancelled"]);
    expect(await requests(dispatcher)).toEqual([]);
  });

  it("status.get waiting matches list.get requests on a worker", async () => {
    const { dispatcher, engine } = await buildDispatcher({
      driverOptions: { latencyMs: { provision: 60_000 } },
    });
    // Both iOS devices are being made: the two requests start, the third queues behind them.
    void request(dispatcher, "agent-a");
    void request(dispatcher, "agent-b");
    void request(dispatcher, "agent-c");
    await expect.poll(() => engine.queueDepth).toBe(1);

    const listed = await requests(dispatcher);
    const { waiting } = await dispatcher.dispatch("status.get", {}, session());

    expect(listed.map((entry) => ("stage" in entry ? entry.stage : undefined))).toEqual([
      "starting",
      "starting",
      "queued",
    ]);
    expect(waiting).toEqual(listed);
  });
});

/** Lets every settled promise and queued continuation run. */
async function flushPromises(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

describe("Dispatcher: component.install", () => {
  const admin = (overrides: Partial<DispatchSession> = {}) =>
    session({ principal: "tok_operator", role: "admin", ...overrides });

  /** An installer stand-in that records every call and installs nothing. */
  function spyInstaller() {
    const install = vi.fn(() =>
      Promise.resolve({ outcome: "installed" as const, version: "unreachable" }),
    );
    return {
      claimProvision: () => () => undefined,
      inProgress: () => [],
      install,
      list: () => Promise.resolve([]),
      remove: vi.fn(() => Promise.reject(new Error("unreachable"))),
    };
  }

  function installCalls(driver: FakeDriver): unknown[] {
    return driver.calls
      .filter((call) => call.operation === "installComponent")
      .map((call) => call.arguments);
  }

  /** Lets the installer and the fake driver run their awaits until `predicate` holds. */
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`never happened: ${label}`);
  }

  it("calls the installer for a missing component and answers installed with the version", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const result = await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );

    expect(result).toEqual({
      component: "27.0",
      outcome: "installed",
      platform: "ios",
      version: "27.0",
    });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("answers already-installed for an installed component and starts no install", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const result = await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "26.5" },
      admin(),
    );

    expect(result).toEqual({
      component: "26.5",
      outcome: "already-installed",
      platform: "ios",
      version: "26.5",
    });
    expect(installCalls(driver)).toEqual([]);
  });

  it("refuses an agent session with FORBIDDEN and never calls the installer", async () => {
    const components = spyInstaller();
    const { dispatcher } = await buildDispatcher({ components });

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(components.install).not.toHaveBeenCalled();
  });

  it("fails with DOWNLOADS_DISABLED under downloads.policy 'never' and never calls the installer", async () => {
    const components = spyInstaller();
    const { dispatcher } = await buildDispatcher({ components, downloadsPolicy: "never" });

    const error = await dispatcher
      .dispatch("component.install", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchError);
    expect(error).toMatchObject({ code: "DOWNLOADS_DISABLED", details: { policy: "never" } });
    expect(components.install).not.toHaveBeenCalled();
  });

  it("installs under downloads.policy 'on-request' with no flag of its own", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin()),
    ).resolves.toMatchObject({ outcome: "installed" });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("joins a lease request's download of the same component: one install, and both succeed", async () => {
    const { components, dispatcher, driver } = await buildDispatcher({
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
    });
    // The engine and the dispatcher hold this same installer, so the spy sees both callers.
    const installerCalls = vi.spyOn(components, "install");
    driver.holdInstalls();

    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the install started");
    const lease = dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
      session(),
    );
    // The lease reaches the installer while the install is still held, so it can only join.
    await until(() => installerCalls.mock.calls.length === 2, "the lease reached the installer");
    expect(installerCalls.mock.calls.map(([request]) => request.component)).toEqual([
      "27.0",
      "27.0",
    ]);
    driver.releaseInstalls();

    await expect(install).resolves.toMatchObject({ outcome: "installed", version: "27.0" });
    await expect(lease).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("runs one install for two calls naming the same component, and gives both its outcome", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.holdInstalls();

    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");
    const second = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ principal: "tok_second" }),
    );
    driver.releaseInstalls();

    const expected = { component: "27.0", outcome: "installed", platform: "ios", version: "27.0" };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("refuses a version containing whitespace with BAD_REQUEST before any driver call", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27 .0" }, admin()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0\n" }, admin()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(driver.calls).toEqual([]);
  });

  it("answers NO_DRIVER for a platform with no driver, and admits nothing", async () => {
    const { dispatcher } = await buildDispatcher();
    const onStarted = vi.fn();

    const error = await dispatcher
      .dispatch("component.install", { platform: "android", version: "35" }, admin({ onStarted }))
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("NO_DRIVER");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("tells the session the call was admitted before it settles", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.holdInstalls();
    const onStarted = vi.fn();

    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onStarted }),
    );
    await until(() => installCalls(driver).length === 1, "the install started");

    expect(onStarted).toHaveBeenCalledOnce();
    driver.releaseInstalls();
    await install;
  });

  it("answers RUNTIME_MISSING when the driver says the component cannot be installed", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.failOn(
      "installComponent",
      1,
      new RuntimeMissingError("ios", "12.0", { downloadable: false }),
    );

    const error = await dispatcher
      .dispatch("component.install", { platform: "ios", version: "12.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("RUNTIME_MISSING");
  });

  it("names the session's principal as the requester of the install it starts", async () => {
    const { dispatcher, eventBus } = await buildDispatcher();
    const started: unknown[] = [];
    eventBus.subscribeAll((envelope) => {
      if (envelope.event === "component.install-started") started.push(envelope.payload);
    });

    await dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin());

    expect(started).toEqual([
      { componentId: "27.0", platform: "ios", requesterId: "tok_operator" },
    ]);
  });

  it("reports a driver's percentage as a fraction clamped to 0..1, and leaves out one that is not a number", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: { installProgress: [Number.NaN, -5, 50, 150] },
    });
    const progress: unknown[] = [];

    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );

    expect(progress).toEqual([
      // The install's start, before the driver reports anything.
      { stage: "downloading" },
      // The driver's NaN, with its fraction left out.
      { stage: "downloading" },
      { fraction: 0, stage: "downloading" },
      { fraction: 0.5, stage: "downloading" },
      { fraction: 1, stage: "downloading" },
    ]);
  });

  /** The fractions one install's `component-progress` pushes carry, the driver reporting `percents`. */
  async function fractionsFor(percents: readonly number[]): Promise<unknown[]> {
    const { dispatcher } = await buildDispatcher({ driverOptions: { installProgress: percents } });
    const fractions: unknown[] = [];
    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({
        onComponentProgress: (update) => {
          if ("fraction" in update) fractions.push(update.fraction);
        },
      }),
    );
    return fractions;
  }

  it("turns a percentage of 1.1 into a fraction of exactly 0.011", async () => {
    // 1.1 / 100 is 0.011000000000000001 in floating point.
    const [fraction] = await fractionsFor([1.1]);

    expect(String(fraction)).toBe("0.011");
  });

  it("turns a percentage of 64.1 into a fraction of exactly 0.641", async () => {
    // 64.1 / 100 is 0.6409999999999999 in floating point.
    const [fraction] = await fractionsFor([64.1]);

    expect(String(fraction)).toBe("0.641");
  });

  it("sends a percentage of 99.96 as 0.999, keeping a fraction of 1 for 100", async () => {
    await expect(fractionsFor([99.96, 100])).resolves.toEqual([0.999, 1]);
  });

  it("sends no fraction with more than three decimals for any percentage from 0 to 100 in steps of 0.1", async () => {
    // Summed rather than computed, so the percentages carry the noise a driver's own arithmetic
    // would.
    const percents: number[] = [];
    for (let percent = 0, step = 0; step <= 1000; step += 1, percent += 0.1) percents.push(percent);

    const fractions = await fractionsFor(percents);

    expect(fractions.length).toBeGreaterThanOrEqual(1001);
    expect(fractions.filter((fraction) => !/^[01](\.\d{1,3})?$/.test(String(fraction)))).toEqual(
      [],
    );
  });

  it("tells a caller behind another install on the platform that it waits, then that it downloads", async () => {
    const { dispatcher, driver } = await buildDispatcher({
      driverOptions: { installProgress: [41] },
    });
    driver.holdInstalls();
    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");

    const progress: unknown[] = [];
    const second = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "28.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );
    await until(() => progress.length === 1, "the second call heard it waits");
    expect(progress).toEqual([{ stage: "waiting" }]);
    driver.releaseInstalls();

    await first;
    await expect(second).resolves.toMatchObject({ outcome: "installed", version: "28.0" });
    expect(progress).toEqual([
      { stage: "waiting" },
      { stage: "downloading" },
      { fraction: 0.41, stage: "downloading" },
      // The installer's own report that the install it ran is complete.
      { fraction: 1, stage: "downloading" },
    ]);
  });

  it("tells a caller that joins an install already running its latest progress while the install is still running", async () => {
    const { dispatcher, driver } = await buildDispatcher({
      driverOptions: { installProgress: [41] },
    });
    driver.holdInstalls();
    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");

    const progress: unknown[] = [];
    const joined = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );
    await until(() => progress.length === 1, "the joining call heard the latest progress");
    expect(progress).toEqual([{ fraction: 0.41, stage: "downloading" }]);

    driver.releaseInstalls();
    await first;
    await expect(joined).resolves.toMatchObject({ outcome: "installed", version: "27.0" });
    expect(installCalls(driver)).toHaveLength(1);
  });
});

describe("Dispatcher: component.list", () => {
  it("lets an agent session list the installed components, the one Simlock installed marked as its", async () => {
    const { clock, dispatcher } = await buildDispatcher();
    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      session({ principal: "tok_operator", role: "admin" }),
    );

    const result = await dispatcher.dispatch("component.list", {}, session());

    expect(result).toEqual({
      components: [
        {
          devices: 0,
          foreignDevices: 0,
          installedBySimlock: false,
          platform: "ios",
          version: "26.5",
        },
        {
          devices: 0,
          foreignDevices: 0,
          installedAt: clock.now(),
          installedBySimlock: true,
          platform: "ios",
          version: "27.0",
        },
      ],
    });
  });

  it("lists only the platform asked for", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch("component.list", { platform: "android" }, session()),
    ).resolves.toEqual({ components: [] });
  });
});

describe("Dispatcher: status.get console address", () => {
  it("status.get carries consoleUrl when HTTP is enabled and omits it when disabled", async () => {
    const enabled = await buildDispatcher({
      http: { enabled: true, host: "127.0.0.1", port: 4711 },
    });
    const disabled = await buildDispatcher({
      http: { enabled: false, host: "127.0.0.1", port: 4711 },
    });

    const on = await enabled.dispatcher.dispatch("status.get", {}, session());
    const off = await disabled.dispatcher.dispatch("status.get", {}, session());

    expect(on.daemon).toEqual({
      consoleUrl: "http://127.0.0.1:4711/",
      health: "running",
      mode: "worker",
    });
    expect(off.daemon).toEqual({ health: "running", mode: "worker" });
    expect("consoleUrl" in off.daemon).toBe(false);
  });
});

describe("Dispatcher: status.get host facts", () => {
  it("reports operating system, version, architecture, and every driver's tool versions", async () => {
    const hostFacts = new HostFactsReader({
      clock: new FakeClock(0),
      drivers: [
        {
          platform: "ios",
          toolVersions: () => Promise.resolve([{ build: "16F6", name: "xcode", version: "16.4" }]),
        },
        {
          platform: "android",
          toolVersions: () => Promise.resolve([{ name: "emulator", version: "35.4.9" }]),
        },
      ],
      system: HOST_SYSTEM,
    });
    await hostFacts.refresh();
    const { dispatcher } = await buildDispatcher({ hostFacts: () => hostFacts.current() });

    const status = (await dispatcher.dispatch("status.get", {}, session())) as {
      readonly host: unknown;
    };

    expect(status.host).toEqual({
      arch: "arm64",
      os: "macOS",
      osVersion: "15.5",
      tools: [
        { build: "16F6", name: "xcode", platform: "ios", version: "16.4" },
        { name: "emulator", platform: "android", version: "35.4.9" },
      ],
    });
  });
});

describe("Dispatcher: status.get RAM budget", () => {
  const sizes = {
    androidBytesPerDevice: 4 * gibibyte,
    iosBytesPerDevice: 2 * gibibyte,
    iosSlimBytesPerDevice: 0.5 * gibibyte,
  };

  it("reports a use equal to the sum of the listed devices' sizes by reported mode, including a slim-spec device still provisioning", async () => {
    const { dispatcher, registry } = await buildDispatcher({
      capacity: {
        strategy: "resource",
        config: {
          limits: {
            android: { maxDevices: 2, maxRunning: 2 },
            ios: { maxDevices: 4, maxRunning: 4 },
            maxRunning: 6,
          },
          ramBudget: sizes,
        },
      },
      driverOptions: { slimmableOsVersions: ["26.5"] },
    });
    const ios = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;
    await dispatcher.dispatch("lease.request", { ...ios, mode: "slim" }, session());
    await dispatcher.dispatch(
      "lease.request",
      { ...ios, mode: "full" },
      session({ principal: "tok_other" }),
    );
    await registry.registerDevice({
      driverData: {},
      driverDeviceId: "driver-provisioning",
      provisionDuration: 0,
      spec: { ...ios, mode: "slim" },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    const listed = status.devices
      .filter((device) => device.state !== "deleted")
      .map((device) =>
        device.mode === "slim" ? sizes.iosSlimBytesPerDevice : sizes.iosBytesPerDevice,
      );
    // The provisioning device is listed `full` until its slim pass, and counts at that size.
    expect(status.devices.map((device) => device.mode).sort()).toEqual(["full", "full", "slim"]);
    expect(status.capacity.ramBudget).toEqual({
      limitBytes: 28 * gibibyte,
      overLimit: false,
      usedBytes: listed.reduce((total, bytes) => total + bytes, 0),
    });
    expect(status.capacity.ramBudget?.usedBytes).toBe(4.5 * gibibyte);
  });

  describe("atRamBudget", () => {
    // 32 GiB of RAM leaves a 28 GiB budget. A full iOS device takes 2 GiB, an Android one 4.
    async function withIosDevices(count: number) {
      const built = await buildDispatcher({
        capacity: {
          strategy: "resource",
          config: {
            limits: {
              android: { maxDevices: 30, maxRunning: 30 },
              ios: { maxDevices: 30, maxRunning: 30 },
              maxRunning: 60,
            },
            ramBudget: sizes,
          },
        },
      });
      for (let index = 0; index < count; index += 1) {
        await built.registry.registerDevice({
          driverData: {},
          driverDeviceId: `driver-${index}`,
          provisionDuration: 0,
          spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        });
      }
      return built;
    }
    const ios = { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" } as const;

    it("is true for a platform whose next full device the planner refuses for RAM, and false while it would be admitted", async () => {
      // 13 devices use 26 of 28 GiB: one more iOS device fits, an Android one does not.
      const roomy = await withIosDevices(13);
      const roomyStatus = await roomy.dispatcher.dispatch("status.get", {}, session());
      expect(roomyStatus.capacity.ios.atRamBudget).toBe(false);
      expect(roomyStatus.capacity.android.atRamBudget).toBe(true);
      await expect(
        roomy.dispatcher.dispatch("lease.request", { ...ios, noWait: true }, session()),
      ).resolves.toBeDefined();

      // 14 devices use all 28 GiB: not even one more iOS device fits.
      const full = await withIosDevices(14);
      const fullStatus = await full.dispatcher.dispatch("status.get", {}, session());
      expect(fullStatus.capacity.ios.atRamBudget).toBe(true);
      await expect(
        full.dispatcher.dispatch("lease.request", { ...ios, noWait: true }, session()),
      ).rejects.toBeInstanceOf(NoCapacityError);
    });

    it("is false under the fixed strategy, which keeps no budget", async () => {
      const { dispatcher } = await buildDispatcher({
        capacity: { strategy: "fixed", config: { maxRunning: 2 } },
      });

      const status = await dispatcher.dispatch("status.get", {}, session());

      expect(status.capacity.ios.atRamBudget).toBe(false);
      expect(status.capacity.android.atRamBudget).toBe(false);
    });
  });

  it("omits the RAM budget under the fixed strategy", async () => {
    const { dispatcher } = await buildDispatcher({
      capacity: { strategy: "fixed", config: { maxRunning: 2 } },
    });

    const status = await dispatcher.dispatch("status.get", {}, session());

    expect(status.capacity).not.toHaveProperty("ramBudget");
  });
});

describe("Dispatcher: startup-readiness parking", () => {
  it("answers status.get with host facts while other operations are parked on startup", async () => {
    const { dispatcher } = await buildDispatcher({
      awaitReady: () => new Promise<void>(() => undefined),
      hostFacts: () => ({
        ...HOST_SYSTEM,
        tools: [{ name: "xcode", platform: "ios", version: "16.4" }],
      }),
    });

    let parked = true;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      parked = false;
    });
    const status = (await dispatcher.dispatch("status.get", {}, session())) as {
      readonly host: { readonly os: string; readonly tools: readonly unknown[] };
    };
    await flush();

    expect(parked).toBe(true);
    expect(status.host.os).toBe("macOS");
    expect(status.host.tools).toHaveLength(1);
  });

  it("parks every operation but status.get on awaitReady", async () => {
    let releaseReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { dispatcher } = await buildDispatcher({ awaitReady: () => readyPromise });

    let statusSettled = false;
    void dispatcher.dispatch("status.get", {}, session()).then(() => {
      statusSettled = true;
    });
    await flush();
    expect(statusSettled).toBe(true);

    let catalogSettled = false;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      catalogSettled = true;
    });
    await flush();
    expect(catalogSettled).toBe(false);

    releaseReady();
    await flush();
    expect(catalogSettled).toBe(true);
  });
});

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

/**
 * ADR 0005 §19a-§19e. The operation's whole job is to run, on this machine, exactly what
 * `driver.passthrough` would have handed a caller who was already on it -- so these check the
 * two things that are genuinely new (the process and its output) and the three the operation
 * inherits and must not lose (root scoping, the refusal list, ownership).
 */
describe("Dispatcher: device.exec", () => {
  const command = { args: ["--set", "/root", "list", "devices"], command: "simctl" };

  async function withLease(overrides: Parameters<typeof buildDispatcher>[0] = {}): Promise<{
    readonly dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"];
    readonly clock: FakeClock;
    readonly leaseId: string;
  }> {
    const built = await buildDispatcher({ passthroughTool: "simctl", ...overrides });
    const grant = await built.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_agent" }),
    );
    return {
      clock: built.clock,
      dispatcher: built.dispatcher,
      leaseId: (grant as { lease: { id: string } }).lease.id,
    };
  }

  it("runs the driver-resolved command and answers its exit code", async () => {
    const runner = new ScriptedProcessRunner([
      { match: command, result: { code: 3, stderr: "", stdout: "" } },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).resolves.toEqual({ exitCode: 3 });

    // The scoping the driver injected is on the command, and its environment is layered over
    // the daemon's own rather than replacing it -- a child given only `SIMLOCK_SCOPED` would
    // have no PATH to find `simctl` with.
    expect(runner.calls[0]).toMatchObject({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      options: { env: { PATH: "/usr/bin", SIMLOCK_SCOPED: "1" } },
    });
  });

  it("streams stdout and stderr chunks to the session in arrival order, unjoined", async () => {
    const runner = new ScriptedProcessRunner([
      {
        chunks: [
          { chunk: "first", stream: "stdout" },
          { chunk: "warning\n", stream: "stderr" },
          { chunk: " and second\n", stream: "stdout" },
        ],
        match: command,
      },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const seen: string[] = [];

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({
        onOutput: (stream, chunk) => {
          seen.push(`${stream}:${chunk}`);
        },
        principal: "tok_agent",
      }),
    );

    // Order across both streams, and each chunk exactly as written: a handler that buffered or
    // line-joined would show two stdout chunks merged, or stderr after both of them.
    expect(seen).toEqual(["stdout:first", "stderr:warning\n", "stdout: and second\n"]);
  });

  it("writes stdin to the child once and closes it", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, stdin: "yes\n", tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(runner.calls[0]?.options.input).toBe("yes\n");
  });

  it("kills a command that outruns exec.timeoutMs and fails with EXEC_TIMEOUT", async () => {
    const runner = new ScriptedProcessRunner([{ hangs: true, match: command }]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    clock.advance(1_000);

    // EXEC_TIMEOUT, not the exit code the kill produced: "we stopped it" and "it failed" are
    // different facts, and only the first tells a caller to raise the limit (ADR §19e).
    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("refuses a verb the driver refuses, exactly as driver.passthrough does", async () => {
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["delete", "ABCD"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/Refusing/);
    // Refused before anything was spawned -- the point of the refusal list is that the command
    // never runs, not that its output is discarded.
    expect(runner.calls).toEqual([]);
  });

  /**
   * The four combinations of the operation's own hook (ADR 0005 §19b/§27), which is
   * `ownsLease` for an agent and something stricter for an admin. The lease under test was
   * granted to principal `tok_agent`, so its `ownerId` and its `requesterId` are both that.
   */
  it("gates an agent session on the lease it owns, and refuses any requesterId it sends outright (round 4, F4)", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    // (1) Someone else's lease: refused -- and naming its requester does not help, because a
    // non-admin session may not name a `requesterId` at all, regardless of whose it is.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    // (2) Its own lease, but naming a `requesterId` -- refused outright, whether or not the
    // name it chose happens to be its own. Round 4, F4: this used to be read and silently
    // ignored (a rule that lived only in the HTTP route, `src/http/app.ts`, and so answered
    // differently over the unix socket); a non-admin session naming an identity at all is now
    // `FORBIDDEN` here, uniformly, on every transport.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    // (2') Its own lease, no requesterId at all: allowed -- this is the ordinary case an agent
    // actually uses.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it("holds an admin session to the lease's requester instead of letting it bypass", async () => {
    // This is the check a gateway's own uplink session runs against: it holds one admin
    // session and proxies many agents through it, so "admin bypasses" would let any
    // admin-role connection drive every lease on the worker (ADR 0005 §19b).
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const admin = session({ principal: "gw:instance-1", role: "admin" });

    // (3) No `requesterId`, so it defaults to the admin's own principal -- which is not who
    // the lease was granted to.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    // (4) Naming the agent it is proxying for: allowed.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        admin,
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it("refuses a tool no driver claims with UNKNOWN_PASSTHROUGH_TOOL, not BAD_REQUEST", async () => {
    // A well-formed request for a wrapper this daemon has no driver for is not a malformed
    // one -- same distinction `driver.passthrough` draws, and the same error code.
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["devices"], leaseId, tool: "adb" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/No driver provides a adb passthrough/);
    expect(runner.calls).toEqual([]);
  });

  it("tells the driver there is no terminal, so it can refuse what needs one", async () => {
    // ADR 0005 §19c: the command runs here, on pipes. The driver is the only thing that knows
    // which of its own commands that rules out (a bare `adb shell`), so the fact travels to
    // it rather than being decided here.
    const seen: unknown[] = [];
    const { dispatcher, leaseId } = await withLease({
      passthroughContextSink: seen,
      processRunner: new ScriptedProcessRunner([{ match: command }]),
    });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await dispatcher.dispatch(
      "driver.passthrough",
      { args: ["list", "devices"], tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(seen).toEqual([{ hasTerminal: false }, undefined]);
  });

  it("answers UNKNOWN_LEASE for an id that names no lease, rather than running the command", async () => {
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: "lse_gone", tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/Unknown lease: lse_gone/);
    expect(runner.calls).toEqual([]);
  });

  it("answers a tool no driver wraps with UNKNOWN_PASSTHROUGH_TOOL, not BAD_REQUEST", async () => {
    // Which wrappers exist is the drivers' answer, so `bash` is a well-formed request this
    // host cannot serve -- the same distinction, and the same code, `driver.passthrough` draws.
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "bash" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/No driver provides a bash passthrough/);
    expect(runner.calls).toEqual([]);
  });

  it("escalates to SIGKILL when a timed-out command ignores SIGTERM", async () => {
    // SIGTERM is a request. A tool that ignores it (or is itself stuck) must not be able to
    // hold the operation -- and the caller's connection -- open past the grace window.
    const runner = new ScriptedProcessRunner([
      { hangs: true, ignoresSigterm: true, match: command },
    ]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    let settled = false;
    void pending.catch(() => (settled = true));

    // The timeout fires and SIGTERM lands; the command ignores it and the operation is still
    // in flight, which is the state the escalation exists for.
    clock.advance(1_000);
    await flush();
    expect(settled).toBe(false);

    clock.advance(10_000);
    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("resolves with the exit code, not EXEC_TIMEOUT, when the command finishes before the timeout timer's callback runs -- even scheduled in the same synchronous burst", async () => {
    // `Promise.race([waited, expired])` -- not a flag either callback sets -- is what this
    // proves the value of: `handle.finish(7)` and `clock.advance(1_000)` are both called here
    // synchronously, one right after the other, with nothing in between observing either
    // settle. A flag-based implementation (`let timedOut = false; timer sets it`) would be at
    // the mercy of which of these two statements a maintainer wrote first, and get it wrong
    // for whichever settles second; `Promise.race` instead answers from whichever promise
    // *actually* settled first, in the order the two calls below run it -- unaffected by which
    // of `waited`/`expired` the `Promise.race([...])` array happens to list first.
    const clock = new FakeClock(1_000);
    const handle = new SettleOnCueHandle();
    const { dispatcher, leaseId } = await withLease({
      clock,
      exec: { timeoutMs: 1_000 },
      processRunner: { spawnStreaming: () => handle } as unknown as ProcessRunner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();

    // The exit settles first, in program order; the timer's callback (which would otherwise
    // report EXEC_TIMEOUT) runs only afterward, in the same synchronous burst.
    handle.finish(7);
    clock.advance(1_000);

    await expect(pending).resolves.toEqual({ exitCode: 7 });
    // And nothing was signalled: a command that finished is not one to kill.
    expect(handle.signals).toEqual([]);
  });

  describe("output delivered across a real exit, against a real NodeProcessRunner", () => {
    // `ScriptedProcessRunner` can't reproduce this class of defect: its scripted handle always
    // awaits a chunk's delivery before it will settle at all, so it cannot model "the child has
    // already exited and closed its pipe while a chunk's delivery to a slow consumer is still
    // outstanding" -- exactly the state a real OS pipe can be in (verified against real Node:
    // `close` can fire in the same tick as the `data` event for a chunk this process runner
    // just paused on). `#deviceExec` (`server.ts`) and the HTTP exec route (`app.ts`) both just
    // hand their transport's own backpressured `onOutput` straight to this same dispatcher
    // call, so a real reproduction here against a real child process is the one place this
    // defect -- and its fix, in `NodeStreamingProcessHandle` -- is actually exercised, for
    // both transports at once.
    function realCommand(script: string): PassthroughResolver {
      return { passthrough: () => ({ args: ["-e", script], command: process.execPath, env: {} }) };
    }
    // The 30 s per-test timeouts below are hang guards, not speed claims: the stalled-delivery
    // case waits out the real 5 s `EXIT_TO_CLOSE_MAX_DEFERRAL_MS` by design, and a 10 s guard
    // left one slow child-process spawn on a busy machine between it and a false failure.

    it("delivers every chunk in full, in order, even when one delivery stalls past the exit grace window", async () => {
      const seen: string[] = [];
      let releaseFirst!: () => void;
      const firstDelivery = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const { dispatcher, leaseId } = await withLease({
        passthroughOverride: realCommand(
          "process.stdout.write('before-exit-A');" +
            "setTimeout(() => { process.stdout.write('before-exit-B'); process.exit(0); }, 20);",
        ),
        processRunner: new NodeProcessRunner(),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: (_stream, chunk) => {
            seen.push(chunk);
            // Stall only the first chunk's delivery, well past the 1s exit-to-close grace
            // window this handle used to settle on regardless.
            return seen.length === 1 ? firstDelivery : undefined;
          },
          principal: "tok_agent",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        settledEarly,
        "device.exec resolved while a chunk's delivery was still pending -- output after it may have been dropped",
      ).toBe(false);

      releaseFirst();
      await expect(pending).resolves.toEqual({ exitCode: 0 });
      expect(seen).toEqual(["before-exit-A", "before-exit-B"]);
    }, 30_000);

    it("fails device.exec loudly, rather than answering a truncated exit code, when a chunk's delivery never resolves", async () => {
      const { dispatcher, leaseId } = await withLease({
        passthroughOverride: realCommand("process.stdout.write('stuck'); process.exit(0);"),
        processRunner: new NodeProcessRunner(),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: () =>
            new Promise<void>(() => {
              // A consumer whose backpressure never clears -- a dead SSE write, a socket that
              // never drains.
            }),
          principal: "tok_agent",
        }),
      );

      await expect(pending).rejects.toThrow(ExecOutputDeliveryStalledError);
    }, 30_000);

    it("reports EXEC_TIMEOUT, not the stalled-delivery error it provokes, when a consumer that stopped reading is why the command outran its timeout", async () => {
      // The common path, not an exotic one: a consumer that stops reading is *why* a
      // streaming command outruns its timeout in the first place -- the backpressure pause
      // that stops the child finishing is the same pause that stalls this chunk's delivery.
      // `exec.timeoutMs` firing and killing the child must still be the answer the caller
      // sees, not the stalled-delivery rejection that killing it provokes as a side effect.
      const { clock, dispatcher, leaseId } = await withLease({
        exec: { timeoutMs: 50 },
        passthroughOverride: realCommand("process.stdout.write('x'); setInterval(() => {}, 1000);"),
        processRunner: new NodeProcessRunner(),
      });

      const pending = dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "simctl" },
        session({
          onOutput: () =>
            new Promise<void>(() => {
              // Never resolves: the stream is paused on this chunk's delivery for the rest
              // of the test, exactly as a client that opened the stream and stopped reading
              // would leave it.
            }),
          principal: "tok_agent",
        }),
      );

      // Let the real child actually spawn and write its one chunk before the timeout fires,
      // so the pending delivery this test depends on genuinely exists.
      await new Promise((resolve) => setTimeout(resolve, 200));
      clock.advance(50);

      await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
    }, 30_000);
  });
});

/** A streamed child that settles only when a test says so, and records what it was signalled
 * with -- enough to tell "we killed it" from "it finished" without a real process. */
class SettleOnCueHandle {
  readonly pid = 99;
  readonly signals: string[] = [];
  #resolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly #result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      this.#resolve = resolve;
    },
  );

  finish(code: number): void {
    this.#resolve({ code, signal: null });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#result;
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(
  downloadsPolicy: Config["downloads"]["policy"] = "on-request",
  leaseOverrides: Partial<Config["lease"]> = {},
  execOverrides: Partial<Config["exec"]> = {},
  capacity: Config["capacity"] = {
    strategy: "resource",
    config: {
      limits: {
        android: { maxDevices: 1, maxRunning: 1 },
        ios: { maxDevices: 2, maxRunning: 2 },
        maxRunning: 3,
      },
      ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
    },
  },
): Config {
  return {
    mode: "worker",
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
    },
    drivers: {},
    exec: { timeoutMs: 600_000, ...execOverrides },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: { policy: downloadsPolicy, acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", slim: { bootTimeoutMs: 600_000 } },
    android: { emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true } },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
      ...leaseOverrides,
    },
    capacity,
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: { rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

describe("Dispatcher: component.remove", () => {
  const admin = (overrides: Partial<DispatchSession> = {}) =>
    session({ principal: "tok_operator", role: "admin", ...overrides });

  function driverCalls(driver: FakeDriver, operation: string): number {
    return driver.calls.filter((call) => call.operation === operation).length;
  }

  /** A dispatcher over a real engine and installer, with iOS 27.0 installed by Simlock. */
  async function withSimlockInstall() {
    const built = await buildDispatcher({
      driverOptions: { componentSizes: { "27.0": 7_000_000_000 }, knownModels: ["iPhone 17 Pro"] },
    });
    await built.dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    return built;
  }

  it("removes a component Simlock installed and emits component.removed with the admin principal as requesterId", async () => {
    const { dispatcher, eventBus } = await withSimlockInstall();

    await expect(
      dispatcher.dispatch(
        "component.remove",
        { platform: "ios", version: "27.0" },
        admin({ principal: "tok_remover" }),
      ),
    ).resolves.toEqual({
      outcome: "removed",
      platform: "ios",
      sizeBytes: 7_000_000_000,
      version: "27.0",
    });
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "component.removed")
        .map((envelope) => envelope.payload),
    ).toEqual([
      {
        componentId: "27.0",
        platform: "ios",
        requesterId: "tok_remover",
        sizeBytes: 7_000_000_000,
        version: "27.0",
      },
    ]);
  });

  it("answers a dry run with would-remove and removes nothing", async () => {
    const { dispatcher, driver } = await withSimlockInstall();

    await expect(
      dispatcher.dispatch(
        "component.remove",
        { dryRun: true, platform: "ios", version: "27.0" },
        admin(),
      ),
    ).resolves.toEqual({
      outcome: "would-remove",
      platform: "ios",
      sizeBytes: 7_000_000_000,
      version: "27.0",
    });
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses an agent session with FORBIDDEN and never reaches the installer", async () => {
    const { components, dispatcher } = await withSimlockInstall();
    const removals = vi.spyOn(components, "remove");

    await expect(
      dispatcher.dispatch("component.remove", { platform: "ios", version: "27.0" }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(removals).not.toHaveBeenCalled();
  });

  it("refuses a component Simlock did not install with COMPONENT_NOT_OWNED", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "26.5" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("COMPONENT_NOT_OWNED");
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses a component a leased device uses with COMPONENT_IN_USE, carrying both counts as details", async () => {
    const { dispatcher, driver, registry } = await withSimlockInstall();
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
      session(),
    );
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["leased"]);

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchError);
    expect(error).toMatchObject({
      code: "COMPONENT_IN_USE",
      details: { devices: 1, foreignDevices: 0 },
    });
    expect(classifyError(error)).toBe("COMPONENT_IN_USE");
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses with COMPONENT_BUSY while an install runs on that platform", async () => {
    const { dispatcher, driver } = await withSimlockInstall();
    driver.holdInstalls();
    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "28.0" },
      admin(),
    );
    await vi.waitFor(() => expect(driverCalls(driver, "installComponent")).toBe(2));

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("COMPONENT_BUSY");
    driver.releaseInstalls();
    await install;
  });

  it("rejects a lease request that resolves to the version being removed with RUNTIME_MISSING, and creates no device record", async () => {
    const { dispatcher, driver, registry } = await withSimlockInstall();
    driver.holdRemovals();
    const removal = dispatcher.dispatch(
      "component.remove",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await vi.waitFor(() => expect(driverCalls(driver, "removeComponent")).toBe(1));

    let leaseError: unknown;
    let leaseSettled = false;
    void dispatcher
      .dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
        session(),
      )
      .then(
        () => undefined,
        (caught: unknown) => {
          leaseError = caught;
        },
      )
      .finally(() => {
        leaseSettled = true;
      });
    // Rejected while the removal is still running, not queued until it ends.
    await vi.waitFor(() => expect(leaseSettled).toBe(true));

    expect(classifyError(leaseError)).toBe("RUNTIME_MISSING");
    expect(registry.snapshot.devices).toEqual([]);
    expect(driverCalls(driver, "provision")).toBe(0);
    driver.releaseRemovals();
    await expect(removal).resolves.toMatchObject({ outcome: "removed" });
  });
});
