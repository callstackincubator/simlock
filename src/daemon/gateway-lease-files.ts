import type { Identity } from "../auth/index.js";
import type { HttpLeaseFiles } from "../http/app.js";

// why: only `main.ts` imports the gateway, so the relay is typed by the shape of the call it takes.
export interface GatewayLeaseFilesOptions {
  readonly relay: (
    workerId: string,
    call: {
      readonly target: string;
      readonly request: Request;
      readonly tenant: string;
      readonly leaseId?: string;
    },
  ) => Promise<Response>;
  readonly requesterPrefix: string;
}

/** why: a gateway holds no file; it relays each file request to the worker that holds the lease, through the worker's `files` target (ADR 0067 §2). */
export function createGatewayLeaseFiles(options: GatewayLeaseFilesOptions): HttpLeaseFiles {
  return {
    handle: (request, identity: Identity, lease, name) => {
      const workerLeaseId = lease.workerLeaseId ?? lease.id;
      const path = `/files/leases/${encodeURIComponent(workerLeaseId)}${
        name === undefined ? "" : `/${encodeURIComponent(name)}`
      }`;
      return options.relay(lease.workerId ?? "", {
        leaseId: workerLeaseId,
        request: new Request(`http://simlock-worker${path}`, {
          headers: request.headers,
          method: request.method,
          signal: request.signal,
          ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
        } as RequestInit),
        target: "files",
        tenant: `${options.requesterPrefix}${identity.principal}`,
      });
    },
  };
}
