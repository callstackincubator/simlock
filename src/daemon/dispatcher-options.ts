import type { z } from "zod";

import type { TokenOperations } from "../auth/index.js";
import type { EventBus } from "../bus/index.js";
import type { EventHistoryHandle } from "../history/index.js";
import type {
  BaselineService,
  CapacityReader,
  CatalogReader,
  CleanupReaper,
  ComponentInstaller,
  Config,
  Doctor,
  Driver,
  HostFacts,
  LatestPresence,
  Nuke,
  PassthroughResolver,
  PhysicalEnrollment,
  Registry,
  StallInput,
  WarmKindForgetter,
  WarmPoolReader,
} from "../core/index.js";
import type { DeviceModeReader, LeaseCommands, QueueControl } from "../leasing/index.js";
import type { LeaseFiles } from "../lease-files/index.js";
import type { ModuleInputs } from "../modules/index.js";
import type { Clock, Logger, ProcessRunner } from "../ports/index.js";
import type {
  OPERATIONS,
  OperationName,
  StatusLoad,
  StatusMemoryPressure,
} from "../contract/index.js";
import type { DispatchSession } from "./dispatch.js";
import type { UpdateCoordinator } from "./update-coordinator.js";

export interface CapabilitySource {
  readonly name: string;
  readonly read: () => Promise<{ readonly state: string; readonly reason?: string }>;
}

export interface DispatcherOptions {
  readonly historyPath?: string;
  readonly capabilitySources?: readonly CapabilitySource[];
  readonly capacity: CapacityReader;
  readonly warmPool: WarmPoolReader;
  readonly catalog: CatalogReader;
  readonly clock: Clock;
  readonly components: Pick<ComponentInstaller, "install" | "inProgress" | "list" | "remove">;
  readonly config: Config;
  readonly doctor?: Doctor;
  readonly eventHistory: Pick<EventHistoryHandle, "replay" | "replayPage" | "status">;
  readonly deviceModes: DeviceModeReader;
  readonly leases: LeaseCommands;
  readonly logger?: Logger;
  /** why: Classifies a thrown error for the `operation` log line (`classifyError` in production).
   * Injected because `error-code.ts` imports this module. Unset or `undefined`: `INTERNAL`. */
  readonly errorCode?: (error: unknown) => string | undefined;
  readonly nuke?: Nuke;
  /** why: `warm.forget`'s one way into the warm pool's learned record; optional so tests that never forget need no pool. */
  readonly warmKinds?: WarmKindForgetter;
  /** why: the baselines' one way in; optional so tests that never save need none. */
  readonly baselines?: Pick<BaselineService, "list" | "remove" | "save">;
  readonly enrollment?: Pick<PhysicalEnrollment, "add" | "remove">;
  readonly passthrough?: PassthroughResolver;
  /** why: the lease's device input, which `device.rotate` writes to; optional so tests that never rotate need none. */
  readonly inputs?: ModuleInputs;
  readonly processRunner?: ProcessRunner;
  readonly leaseFiles?: Pick<LeaseFiles, "folderOf" | "openFile">;
  /**
   * why: The environment a `device.exec` child starts from, before the driver's own scoping keys are
   * layered on top. Injected rather than read from `process.env` here (architecture rule 9),
   * and layered rather than replaced because `ProcessRunner` replaces a child's environment
   * wholesale: a child given only `--set`/`-P` scoping would lose `PATH` and never find the
   * tool it was pointed at.
   */
  readonly execEnv?: NodeJS.ProcessEnv;
  readonly queue: QueueControl;
  readonly presence?: (driverDeviceId: string) => LatestPresence | undefined;
  readonly reaper: CleanupReaper;
  readonly registry: Registry;
  readonly stalls?: {
    readonly drivers: readonly Pick<Driver, "estimate" | "platform">[];
    readonly claims: NonNullable<StallInput["claims"]>;
  };
  /**
   * why: ADR 0003 §11: "token create|list|revoke become daemon operations. The daemon is the only
   * owner of the tokens." Optional so tests that don't exercise `token.*` (the overwhelming
   * majority) don't need to fabricate one -- `tokenCreate`/`tokenList`/`tokenRevoke` throw a
   * clear `DispatchError` when it is missing rather than crashing on `undefined.create(...)`.
   */
  readonly tokens?: TokenOperations;
  // why: ADR 0081 §2: a revoked token's open sessions close at once; the daemon server holds them, and is built after the dispatcher.
  readonly closeSessionsForToken?: (tokenId: string) => void;
  readonly health: () => "starting" | "running" | "failed";
  readonly hostFacts: () => HostFacts;
  readonly load?: () => StatusLoad | undefined;
  readonly memoryPressure?: () => StatusMemoryPressure | undefined;
  readonly awaitReady: () => Promise<void>;
  readonly instanceId: string;
  readonly version: string;
  readonly eventBus?: Pick<EventBus, "subscribe">;
  readonly update?: UpdateCoordinator;
}

/**
 * why: A handler's declared *input* type is tied to its operation's contract schema (real
 * type-checking value: a handler that reads `input.wrongField` fails to compile). Its return
 * type is deliberately left as `unknown` rather than `z.infer<...Output>`: core's domain types
 * (`LeaseRecord`, `DoctorReport`, ...) are hand-mirrored by the contract's schemas, not reused
 * (see `schemas.ts`'s module comment -- keeping private types off the public surface is the
 * whole point), so they are not always structurally identical to what `z.infer` produces
 * (`readonly` vs. mutable arrays, in particular). `dispatch()`'s `#parseOutput` is what actually
 * enforces the contract at the boundary, exactly as it did before this PR when handlers lived
 * in `DaemonServer` and returned `unknown` too -- this is not a new gap, just a preserved one.
 */
export type Handler<Op extends OperationName> = (
  input: z.infer<(typeof OPERATIONS)[Op]["input"]>,
  session: DispatchSession,
) => Promise<unknown> | unknown;

export type WorkerOperationName = Exclude<OperationName, "daemon.stop">;
