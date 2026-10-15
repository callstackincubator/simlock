// fallow-ignore-next-line unused-type -- the shape of a definition's `config`, which a module's `definition.ts` names.
export type { ModuleConfig } from "./types.js";
// fallow-ignore-next-line unused-type -- the dependencies a module's `mount` receives, which a module's worker names.
export type { MountDeps } from "./types.js";
export type {
  ModuleCapabilitySource,
  ModuleDispatch,
  ModuleEndedLease,
  ModuleFinding,
  ModuleLeaseEndParticipant,
  ModuleMount,
  ModuleRelayTarget,
  OptionalModuleDefinition,
  WorkerContext,
  WorkerHooks,
  WorkerModule,
} from "./types.js";
export { createModuleHost } from "./host.js";
