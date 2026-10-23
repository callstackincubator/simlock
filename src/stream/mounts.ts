import {
  handleStreamRequest,
  relayedDeviceTargetOf,
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
  (request: Request, tenant: string, leaseId: string | undefined): Promise<Response>;
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
  return (request, tenant, leaseId) =>
    // why: a relayed exchange arrives carrying the tenant it was relayed under, which is what the
    // worker checks its own registry against -- the same way `device.exec` names the requester a
    // gateway speaks for. Nothing on this door is a claim the worker takes on faith, and a relay is
    // admitted only from a gateway session, so it is as trusted as the uplink it came on and no more.
    leaseId === undefined
      ? handleStreamRequest(
          options,
          request,
          // why: a relay is admitted only from a gateway session, and the gateway has already refused a
          // caller that is not an operator, so a device stream on this door is served whatever the tenant.
          { principal: tenant, requesterId: tenant, role: "operator" },
          relayedDeviceTargetOf(new URL(request.url).pathname),
        )
      : handleStreamRequest(
          options,
          request,
          { principal: tenant, requesterId: tenant, role: "agent" },
          leaseId,
        );
}
