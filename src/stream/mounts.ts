import type { ModuleLease } from "../modules/index.js";
import {
  handleStreamRequest,
  relayedDeviceTargetOf,
  relayedLeaseTargetOf,
  streamTargetOf,
  type StreamServiceOptions,
} from "./service.js";

// why: the shape the HTTP layer mounts, declared here rather than imported from `src/http`, because a
// stream is the same exchange whether a console on this host asks for it or a gateway relays one, and a
// component that imports the front end it is mounted into cannot be mounted into a relay as well.
export interface StreamMount {
  handle(
    request: Request,
    identity: { readonly principal: string; readonly role: string },
  ): Promise<Response>;
}

export interface StreamRelayTarget {
  (request: Request, tenant: string): Promise<Response>;
}

export interface StreamLeaseHandler {
  (
    request: Request,
    identity: { readonly principal: string; readonly role: string },
    lease: ModuleLease,
  ): Promise<Response>;
}

// why: the lease is resolved and its owner checked by the HTTP layer before this runs, so the handler
// takes the lease as given and names a stream by it.
export function createStreamLeaseHandler(options: StreamServiceOptions): StreamLeaseHandler {
  return (request, identity, lease) =>
    handleStreamRequest(
      options,
      request,
      {
        principal: identity.principal,
        role: identity.role === "operator" ? "operator" : "agent",
      },
      {
        leaseId: lease.id,
        ...(lease.workerId === undefined ? {} : { workerId: lease.workerId }),
        ...(lease.workerLeaseId === undefined ? {} : { workerLeaseId: lease.workerLeaseId }),
      },
    );
}

export function createStreamMount(options: StreamServiceOptions): StreamMount {
  return {
    handle: (request, identity) =>
      handleStreamRequest(
        options,
        request,
        {
          principal: identity.principal,
          role: identity.role === "operator" ? "operator" : "agent",
        },
        streamTargetOf(new URL(request.url).pathname),
      ),
  };
}

export function createStreamRelayTarget(options: StreamServiceOptions): StreamRelayTarget {
  // why: a relay is admitted only from a gateway session, and the gateway has already refused a caller
  // that is not an operator, so a device stream on this door is served whatever the tenant.
  return (request, tenant) => {
    const { pathname } = new URL(request.url);
    return handleStreamRequest(
      options,
      request,
      { principal: tenant, role: "operator" },
      relayedDeviceTargetOf(pathname) ?? relayedLeaseTargetOf(pathname),
    );
  };
}
