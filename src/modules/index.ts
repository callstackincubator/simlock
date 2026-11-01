// fallow-ignore-next-line unused-type -- part of the contract a module imports from this index; no registered module names it yet.
export type { ModuleConfig } from "./types.js";
// fallow-ignore-next-line unused-type -- part of the contract a module imports from this index; no registered module names it yet.
export type { MountDeps } from "./types.js";
export type {
  FleetLease,
  FleetLeases,
  GatewayContext,
  GatewayModule,
  ModuleCapabilitySource,
  ModuleDeviceTcp,
  ModuleDispatch,
  ModuleEndedLease,
  ModuleFinding,
  ModuleHttpResponse,
  LeaseInputHandle,
  ModuleInputs,
  ModuleLease,
  ModuleLeaseEndParticipant,
  ModuleLeaseHandler,
  ModuleLeaseSocketAccept,
  ModuleLeaseSocketHandler,
  ModuleMount,
  ModuleRegistryView,
  ModuleRelayTarget,
  ModuleRelayTwoWayTarget,
  ModuleTwoWayRelay,
  ModuleTokenRecord,
  ModuleTokens,
  OptionalModuleDefinition,
  WorkerContext,
  WorkerHooks,
  WorkerModule,
  WorkerView,
} from "./types.js";
export { createModuleHost } from "./host.js";
export {
  createGatewayChannelLink,
  type GatewayChannelLinkOptions,
  channelSocket,
  unknownLease,
  upgradeRequired,
} from "./relay-channel.js";
