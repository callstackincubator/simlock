import type { Identity } from "../auth/index.js";
import { withCallersLeaseId } from "./callers-lease-id.js";
import { MAX_FILE_BYTES } from "../lease-files/index.js";
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
    handle: async (request, identity: Identity, lease, name) => {
      const declared = request.headers.get("content-length");
      if (name !== undefined && declared !== null && Number(declared) > MAX_FILE_BYTES) {
        return Response.json(
          {
            error: {
              code: "FILE_TOO_LARGE",
              message: `File ${name} is over the 2 GiB limit for one file`,
              name,
            },
          },
          { status: 413 },
        );
      }
      const workerLeaseId = lease.workerLeaseId ?? lease.id;
      const path = `/files/leases/${encodeURIComponent(workerLeaseId)}${
        name === undefined ? "" : `/${encodeURIComponent(name)}`
      }`;
      const relayed = await options.relay(lease.workerId ?? "", {
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
      const answer = await withCallersLeaseId(relayed, workerLeaseId, lease.id);
      const length = answer.headers.get("simlock-content-length");
      if (length === null || !/^\d{1,16}$/.test(length)) return answer;
      // why: the relay carries no `Content-Length`, so the worker sent the body's length under its own header and the gateway gives it back to the caller.
      const headers = new Headers(answer.headers);
      headers.set("content-length", length);
      return new Response(answer.body, { headers, status: answer.status });
    },
  };
}
