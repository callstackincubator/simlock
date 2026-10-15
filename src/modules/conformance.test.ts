import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../core/index.js";
import { optionalModules } from "../module-registry/index.js";
import { FakeSystemStats, MemoryFilesystem, NoopLogger } from "../ports/index.js";
import {
  createModuleHost,
  type ModuleEndedLease,
  type OptionalModuleDefinition,
  type WorkerView,
} from "./index.js";
import { fakeGatewayContext, fakeModule, fakeWorkerContext } from "./testing.js";

const HOOK_DEADLINE_MS = 30_000;

const ended: ModuleEndedLease = {
  deviceId: "dev-1",
  leaseId: "lease-1",
  ownerId: "agent-1",
  platform: "ios",
  reason: "explicit",
};

const hooked = fakeModule({
  hooks: {
    afterSocketClaimed: () => undefined,
    beforeDeviceReclaim: (_lease, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    beforeDrain: () => Promise.resolve(),
    beforeDriversDispose: () => Promise.resolve(),
  },
  name: "hooked",
});
const plain = fakeModule({ name: "plain" });
const gatewayHooked = fakeModule({
  gateway: { module: { hooks: { beforeDrain: () => Promise.resolve() } } },
  name: "gateway-hooked",
});

const subjects: readonly (readonly [string, OptionalModuleDefinition<unknown>])[] = [
  ...optionalModules.map((definition) => [definition.name, definition] as const),
  ...[hooked, plain, gatewayHooked].map(
    (module) =>
      [module.definition.name, module.definition as OptionalModuleDefinition<unknown>] as const,
  ),
];

async function configFor(definition: OptionalModuleDefinition<unknown>, on: boolean) {
  return loadConfig({
    filesystem: new MemoryFilesystem(),
    modules: [{ ...definition.config, name: definition.name }],
    overrides: { capabilities: { [definition.name]: { enabled: on } } } as never,
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
  });
}

describe("every optional module's contract", () => {
  it.each(subjects)(
    "%s: the name passes the capability name check, and no name repeats",
    (name) => {
      expect(name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
      expect(subjects.filter(([other]) => other === name)).toHaveLength(1);
    },
  );

  it.each(subjects)("%s: off means not loaded, and reported off", async (name, definition) => {
    const loadWorker = vi.spyOn(definition, "loadWorker");
    const { ctx } = await fakeWorkerContext(name, definition.config.defaults);

    const host = await createModuleHost({
      config: await configFor(definition, false),
      context: ctx,
      definitions: [definition],
      logger: new NoopLogger(),
      role: "worker",
    });

    expect(loadWorker).not.toHaveBeenCalled();
    expect(await host.capabilitySources[0]?.read()).toEqual({ state: "off" });
  });

  it.each(subjects)("%s: createWorker starts nothing", async (name, definition) => {
    const { ctx, clock, processRunner, processSupervisor } = await fakeWorkerContext(
      name,
      definition.config.defaults,
    );

    const loaded = await definition.loadWorker();
    loaded.createWorker(ctx);

    expect({
      runs: processRunner.calls.length,
      signals: processSupervisor.signals.length,
      timers: clock.pendingTimerCount,
    }).toEqual({ runs: 0, signals: 0, timers: 0 });
  });

  it.each(subjects)(
    "%s: each declared hook settles within its row's deadline",
    async (name, definition) => {
      const { ctx, clock } = await fakeWorkerContext(name, definition.config.defaults);
      const worker = (await definition.loadWorker()).createWorker(ctx);
      const hooks = worker.hooks ?? {};
      const controller = new AbortController();
      const settled: string[] = [];
      const run = (hook: string, call: (() => unknown) | undefined) =>
        call === undefined
          ? undefined
          : Promise.resolve(call()).then(() => {
              settled.push(hook);
            });

      const pending = [
        run("afterSocketClaimed", hooks.afterSocketClaimed),
        run("beforeDrain", hooks.beforeDrain),
        run("beforeDriversDispose", hooks.beforeDriversDispose),
        run(
          "beforeDeviceReclaim",
          hooks.beforeDeviceReclaim === undefined
            ? undefined
            : () => hooks.beforeDeviceReclaim?.(ended, controller.signal),
        ),
      ];
      clock.advance(HOOK_DEADLINE_MS);
      controller.abort();
      await Promise.all(pending);

      expect(settled.sort()).toEqual(Object.keys(hooks).sort());
    },
  );
});

const gatewaySubjects = subjects.filter(([, definition]) => definition.loadGateway !== undefined);

describe("every optional module's gateway side", () => {
  it.each(gatewaySubjects)("%s: createGateway starts nothing", async (name, definition) => {
    const { ctx, clock } = await fakeGatewayContext(name, definition.config.defaults);

    (await definition.loadGateway?.())?.createGateway(ctx);

    expect(clock.pendingTimerCount).toBe(0);
  });

  it.each(gatewaySubjects)(
    "%s: beforeDrain settles within the hook deadline",
    async (name, definition) => {
      const { ctx, clock } = await fakeGatewayContext(name, definition.config.defaults);
      const gateway = (await definition.loadGateway?.())?.createGateway(ctx);
      let settled = false;

      const pending = Promise.resolve(gateway?.hooks?.beforeDrain?.()).then(() => {
        settled = true;
      });
      clock.advance(HOOK_DEADLINE_MS);
      await pending;

      expect(settled).toBe(true);
    },
  );
});

describe("a gateway module's serving()", () => {
  it("keeps a connected worker whose capability is available even when its catalog is unread, and drops one that is not connected", async () => {
    const mine = fakeModule({ gateway: { module: {} }, name: "mine" });
    const definition = mine.definition as OptionalModuleDefinition<unknown>;
    const available = [{ name: "mine", state: "available" }];
    const views = [
      { capabilities: available, connection: "connected", id: "unread" },
      { capabilities: available, connection: "disconnected", id: "gone" },
    ] as never as readonly WorkerView[];
    const { ctx } = await fakeGatewayContext("mine", definition.config.defaults);

    await createModuleHost({
      config: await configFor(definition, true),
      definitions: [definition],
      logger: new NoopLogger(),
      parts: { ...ctx, worker: () => undefined, workers: () => views } as never,
      role: "gateway",
    });

    expect(mine.gatewayContexts[0]?.serving().map((view) => view.id)).toEqual(["unread"]);
  });
});

describe("the registry", () => {
  it("registers agent-device, so the conformance suite above runs over it", () => {
    expect(subjects.map(([name]) => name)).toContain("agent-device");
  });
});
