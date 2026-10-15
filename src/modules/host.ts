import { CORE_ROUTE_SEGMENTS, MAX_CAPABILITIES, capabilityNameSchema } from "../contract/index.js";
import type { Clock, Logger } from "../ports/index.js";
import type {
  GatewayHostOptions,
  GatewayModule,
  GatewayModuleHost,
  ModuleCapabilitySource,
  ModuleHost,
  ModuleHostOptions,
  ModuleLeaseEndParticipant,
  ModuleMount,
  ModuleRelayTarget,
  MountDeps,
  OptionalModuleDefinition,
  WorkerModule,
} from "./types.js";

const HOOK_DEADLINE_MS = 30_000;

interface Started {
  readonly name: string;
  readonly worker: WorkerModule;
}

type StopHook = "beforeDrain" | "beforeDriversDispose";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkNames(definitions: readonly OptionalModuleDefinition<unknown>[]): void {
  const seen = new Set<string>();
  for (const { name } of definitions) {
    if (!capabilityNameSchema.safeParse(name).success) {
      throw new Error(`Optional module "${name}": the name is not a valid capability name`);
    }
    if (seen.has(name)) {
      throw new Error(`Optional module "${name}": the name is already taken`);
    }
    seen.add(name);
    if (CORE_ROUTE_SEGMENTS.includes(name)) {
      throw new Error(`Optional module "${name}": the name is reserved for a core route`);
    }
  }
  const total = definitions.length;
  if (total > MAX_CAPABILITIES) {
    const last = definitions[definitions.length - 1]?.name ?? "";
    throw new Error(
      `Optional module "${last}": ${String(total)} capabilities exceed the limit of ${String(MAX_CAPABILITIES)}`,
    );
  }
}

async function createOne(
  definition: OptionalModuleDefinition<unknown>,
  options: ModuleHostOptions,
): Promise<WorkerModule> {
  const { name } = definition;
  let worker: WorkerModule;
  try {
    const loaded = await definition.loadWorker();
    const section = Object.fromEntries(
      Object.entries(options.config.capabilities[name] ?? {}).filter(([key]) => key !== "enabled"),
    );
    worker = loaded.createWorker({
      ...options.context,
      config: section,
      daemonConfig: options.config,
      logger: options.logger.child(name),
      name,
    });
  } catch (error: unknown) {
    throw new Error(`Optional module "${name}" failed to start: ${messageOf(error)}`, {
      cause: error,
    });
  }
  if (worker.capability.name !== name) {
    throw new Error(
      `Optional module "${name}" reports a capability named "${worker.capability.name}"`,
    );
  }
  return worker;
}

async function runHook(
  logger: Logger,
  module: string,
  hook: string,
  call: () => unknown,
): Promise<void> {
  try {
    await call();
  } catch (error: unknown) {
    logger.error("Optional module hook failed", { hook, message: messageOf(error), module });
  }
}

async function runWithDeadline(
  logger: Logger,
  clock: Clock,
  hook: string,
  steps: readonly { readonly name: string; readonly call: () => unknown }[],
): Promise<void> {
  const running = new Set<string>();
  const calls = steps.map(({ call, name }) => {
    running.add(name);
    return runHook(logger, name, hook, call).finally(() => {
      running.delete(name);
    });
  });
  if (calls.length === 0) return;
  let timer: ReturnType<typeof clock.setTimer> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = clock.setTimer(HOOK_DEADLINE_MS, resolve);
  });
  await Promise.race([Promise.all(calls), deadline]);
  if (timer !== undefined) clock.cancel(timer);
  for (const module of running) {
    logger.warn("Optional module hook ran out of time", { hook, module });
  }
}

async function createGatewaySide(
  definition: OptionalModuleDefinition<unknown>,
  options: GatewayHostOptions,
): Promise<GatewayModule> {
  const { name } = definition;
  const { parts } = options;
  try {
    const loaded = await definition.loadGateway?.();
    const section = Object.fromEntries(
      Object.entries(options.config.capabilities[name] ?? {}).filter(([key]) => key !== "enabled"),
    );
    return (
      loaded?.createGateway({
        cancelPending: (requesterId) => parts.cancelPending(requesterId),
        clock: parts.clock,
        config: section,
        daemonConfig: options.config,
        grantedDevices: () => parts.grantedDevices(),
        instanceId: parts.instanceId,
        leases: parts.leases,
        logger: options.logger.child(name),
        name,
        relay: (workerId, request, tenant, leaseId) =>
          parts.relay(workerId, {
            request,
            target: name,
            tenant,
            ...(leaseId === undefined ? {} : { leaseId }),
          }),
        requesterPrefix: parts.requesterPrefix,
        serving: () =>
          parts
            .workers()
            .filter(
              (view) =>
                view.connection === "connected" &&
                view.capabilities?.some(
                  (entry) => entry.name === name && entry.state === "available",
                ) === true,
            ),
        startedAt: parts.startedAt,
        worker: (id) => parts.worker(id),
        workers: () => parts.workers(),
      }) ?? {}
    );
  } catch (error: unknown) {
    throw new Error(`Optional module "${name}" failed to start: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

async function createGatewayHost(options: GatewayHostOptions): Promise<GatewayModuleHost> {
  checkNames(options.definitions);
  const started: { readonly name: string; readonly gateway: GatewayModule }[] = [];
  for (const definition of options.definitions) {
    if (options.config.capabilities[definition.name]?.enabled !== true) continue;
    if (definition.loadGateway === undefined) continue;
    started.push({ gateway: await createGatewaySide(definition, options), name: definition.name });
  }
  return {
    beforeDrain: () =>
      runWithDeadline(
        options.logger,
        options.parts.clock,
        "beforeDrain",
        started.flatMap(({ gateway, name }) => {
          const call = gateway.hooks?.beforeDrain;
          return call === undefined ? [] : [{ call: () => call(), name }];
        }),
      ),
    mounts: (deps) =>
      started.flatMap(({ gateway, name }) =>
        gateway.mount === undefined ? [] : [{ handle: gateway.mount(deps), prefix: name }],
      ),
  };
}

export function createModuleHost(options: GatewayHostOptions): Promise<GatewayModuleHost>;
export function createModuleHost(options: ModuleHostOptions): Promise<ModuleHost>;
export async function createModuleHost(
  options: GatewayHostOptions | ModuleHostOptions,
): Promise<GatewayModuleHost | ModuleHost> {
  if (options.role === "gateway") return createGatewayHost(options);
  return createWorkerHost(options);
}

async function createWorkerHost(options: ModuleHostOptions): Promise<ModuleHost> {
  const { definitions, logger } = options;
  checkNames(definitions);

  const capabilitySources: ModuleCapabilitySource[] = [];
  const started: Started[] = [];
  for (const definition of definitions) {
    if (options.config.capabilities[definition.name]?.enabled !== true) {
      capabilitySources.push({
        name: definition.name,
        read: () => Promise.resolve({ state: "off" }),
      });
      continue;
    }
    const worker = await createOne(definition, options);
    started.push({ name: definition.name, worker });
    capabilitySources.push(worker.capability);
  }

  const relayTargets: Record<string, ModuleRelayTarget> = {};
  for (const { name, worker } of started) {
    if (worker.relayTarget !== undefined) relayTargets[name] = worker.relayTarget;
  }

  const leaseEndParticipants: ModuleLeaseEndParticipant[] = [];
  for (const { worker } of started) {
    const reclaim = worker.hooks?.beforeDeviceReclaim;
    if (reclaim !== undefined) {
      leaseEndParticipants.push({ leaseEnded: (ended, signal) => reclaim(ended, signal) });
    }
  }

  const runStopStep = (hook: StopHook): Promise<void> =>
    runWithDeadline(
      logger,
      options.context.clock,
      hook,
      started.flatMap(({ name, worker }) => {
        const call = worker.hooks?.[hook];
        return call === undefined ? [] : [{ call: () => call(), name }];
      }),
    );

  // why: doctor reads findings at every run and at startup, so a module that keeps throwing is logged when it starts to, not on every read.
  const unreadable = new Set<string>();

  return {
    afterSocketClaimed(): void {
      for (const { name, worker } of started) {
        const call = worker.hooks?.afterSocketClaimed;
        if (call !== undefined) void runHook(logger, name, "afterSocketClaimed", () => call());
      }
    },
    beforeDrain: () => runStopStep("beforeDrain"),
    beforeDriversDispose: () => runStopStep("beforeDriversDispose"),
    capabilitySources,
    findings() {
      return started.flatMap(({ name, worker }) => {
        try {
          const found = worker.findings?.() ?? [];
          unreadable.delete(name);
          return found.map((finding) => ({
            kind: "module-unavailable" as const,
            message: finding.message,
            module: name,
            remedy: finding.remedy,
          }));
        } catch (error: unknown) {
          if (!unreadable.has(name)) {
            unreadable.add(name);
            logger.warn("Could not read optional module findings", {
              message: messageOf(error),
              module: name,
            });
          }
          return [];
        }
      });
    },
    leaseEndParticipants,
    mounts(deps: MountDeps): readonly ModuleMount[] {
      return started.flatMap(({ name, worker }) =>
        worker.mount === undefined ? [] : [{ handle: worker.mount(deps), prefix: name }],
      );
    },
    relayTargets,
  };
}
