import type {
  ModuleEndedLease,
  ModuleLeaseHandler,
  ModuleLeaseSocketHandler,
  ModuleRelayTwoWayTarget,
  WorkerContext,
} from "../modules/index.js";
import type { Clock, Logger } from "../ports/index.js";
import { createGatewayInputLink, type GatewayInputLinkOptions } from "./gateway-link.js";
import { upgradeRequired } from "./refusal.js";
import { createWorkerInputLink, type InputRegistry } from "./worker-link.js";

export interface WorkerInputOptions {
  readonly clock: Clock;
  readonly name: string;
  readonly logger: Logger;
  readonly inputs: WorkerContext<unknown>["inputs"];
  readonly registry: InputRegistry;
}

export interface WorkerInput {
  readonly capability: {
    readonly name: string;
    read(): Promise<{ readonly state: "available" }>;
  };
  readonly leaseRoute: ModuleLeaseHandler;
  readonly leaseEnded: (ended: ModuleEndedLease) => Promise<void>;
  readonly drain: () => Promise<void>;
  readonly relayTwoWay: ModuleRelayTwoWayTarget;
  readonly socket: ModuleLeaseSocketHandler;
}

const leaseRoute: ModuleLeaseHandler = () => Promise.resolve(upgradeRequired());

export function createWorkerInput(options: WorkerInputOptions): WorkerInput {
  const link = createWorkerInputLink({
    clock: options.clock,
    inputs: options.inputs,
    registry: options.registry,
  });
  return {
    capability: { name: options.name, read: () => Promise.resolve({ state: "available" }) },
    drain: link.drain,
    leaseEnded: link.leaseEnded,
    leaseRoute,
    relayTwoWay: link.relayTwoWay,
    socket: link.socket,
  };
}

export function createGatewayInput(options: GatewayInputLinkOptions): {
  readonly leaseRoute: ModuleLeaseHandler;
  readonly socket: ModuleLeaseSocketHandler;
  readonly drain: () => void;
} {
  const link = createGatewayInputLink(options);
  return { drain: link.drain, leaseRoute, socket: { open: link.open } };
}
