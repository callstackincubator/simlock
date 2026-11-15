import type { MiddlewareHandler } from "hono";

import type { Auth, Identity } from "../auth/index.js";
import type { EventBus } from "../bus/index.js";
import type { DeviceRecord } from "../core/index.js";
import type { OwnerRoutedFacts } from "../daemon/owner-routed-facts.js";
import type { Clock, IdGenerator, LeaseSocketAccept, Logger } from "../ports/index.js";
import type { AuthEnv } from "./auth.js";
import type { HttpDispatch } from "./dispatcher-session.js";
import type { LeaseNoticeBuffer } from "./notices.js";
import type { HttpLeaseDevice, LeaseRequestReader, LeaseRequestTracker } from "./tracker.js";

/**
 * why: The device fields the lease routes read: what a lease payload is built from, plus two that
 * only one kind of daemon has. A worker's own registry record carries `state`, which `DELETE
 * /v1/leases/:id` reports; a gateway holds no device state of its own and leaves it out rather
 * than inventing one. A gateway's device carries the `workerId` it lives on, because a device
 * id is one worker's claim and is matched only together with the lease's own `workerId`.
 */
export interface HttpRegistryDevice extends HttpLeaseDevice {
  readonly state?: DeviceRecord["state"];
  readonly workerId?: string;
}

export interface HttpRegistryReader {
  readonly snapshot: {
    readonly devices: readonly HttpRegistryDevice[];
  };
}

export interface HttpGatewayDeps {
  readonly dispatch: HttpDispatch;
  readonly registry: HttpRegistryReader;
  readonly leaseRequests: LeaseRequestReader;
  readonly eventBus: EventBus;
  readonly ownerRoutedFacts: OwnerRoutedFacts;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly auth: Pick<Auth, "authenticateRequest">;
  readonly answerDownloadsEarly?: boolean | undefined;
  readonly mounts?: readonly HttpMount[];
  readonly leaseRoutes?: readonly HttpLeaseRoute[];
  readonly leaseFiles: HttpLeaseFiles;
}

export interface HttpLeaseFiles {
  handle(
    request: Request,
    identity: Identity,
    lease: HttpLeaseSocketLease,
    name: string | undefined,
  ): Promise<Response>;
}

// why: the lease is resolved here, with `lease.get`'s own owner-or-operator answer, so a module's
// lease handler never checks who owns it; http knows a module only by its name.
export interface HttpLeaseRoute {
  readonly name: string;
  // why: the module's two-step socket handler, run for a WebSocket upgrade of the same path.
  readonly socket?: {
    open(
      request: Request,
      identity: Identity,
      lease: HttpLeaseSocketLease,
    ): Promise<Response | HttpLeaseSocketAccept>;
  };
  handle(request: Request, identity: Identity, lease: HttpLeaseSocketLease): Promise<Response>;
}

interface HttpLeaseSocketLease {
  readonly id: string;
  readonly deviceId: string;
  readonly workerId?: string;
  readonly workerLeaseId?: string;
}

export type HttpLeaseSocketAccept = LeaseSocketAccept;

// why: what the upgrade router needs of a lease socket request: the refusal to send before the
// upgrade, or the accept to run on the upgraded socket.
export type HttpLeaseSocketOutcome =
  | { readonly response: Response }
  | { readonly accept: HttpLeaseSocketAccept };

export interface LeaseSocketCapture {
  accept?: HttpLeaseSocketAccept;
}

export interface HttpMount {
  readonly prefix: string;
  handle(request: Request, identity: Identity): Promise<Response>;
}

export type Env = AuthEnv;

export interface HttpAppDisposable {
  readonly dispose: () => void;
  // why: a WebSocket upgrade of a lease route goes through the app's own auth and lease resolution,
  // so a refusal is the answer any request to the path would get; only the accept is new.
  readonly leaseSocket: (request: Request) => Promise<HttpLeaseSocketOutcome>;
}

// why: what the lease route blocks close over: the app's dependencies, its request tracker and
// notice buffer, and the agent auth middleware every route in them runs.
export interface HttpAppContext {
  readonly deps: HttpGatewayDeps;
  readonly tracker: LeaseRequestTracker;
  readonly notices: LeaseNoticeBuffer;
  readonly agentAuth: MiddlewareHandler<Env>;
}
