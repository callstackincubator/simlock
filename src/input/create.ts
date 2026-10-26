import type {
  ModuleLeaseHandler,
  ModuleLeaseSocketHandler,
  ModuleRelayTwoWayTarget,
  WorkerContext,
} from "../modules/index.js";
import type { Logger } from "../ports/index.js";
import { createGatewayInputLink, type GatewayInputLinkOptions } from "./gateway-link.js";
import { upgradeRequired } from "./refusal.js";
import { createWorkerInputLink, type InputRegistry } from "./worker-link.js";

export interface WorkerInputOptions {
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
  readonly relayTwoWay: ModuleRelayTwoWayTarget;
}

const leaseRoute: ModuleLeaseHandler = () => Promise.resolve(upgradeRequired());

export function createWorkerInput(options: WorkerInputOptions): WorkerInput {
  const link = createWorkerInputLink({ inputs: options.inputs, registry: options.registry });
  return {
    capability: { name: options.name, read: () => Promise.resolve({ state: "available" }) },
    leaseRoute,
    relayTwoWay: link.relayTwoWay,
  };
}

export function createGatewayInput(options: GatewayInputLinkOptions): {
  readonly leaseRoute: ModuleLeaseHandler;
  readonly socket: ModuleLeaseSocketHandler;
} {
  return { leaseRoute, socket: createGatewayInputLink(options) };
}
