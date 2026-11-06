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
      readonly upload?: { readonly name: string; readonly silenceMs: number };
    },
  ) => Promise<Response>;
  readonly requesterPrefix: string;
  readonly silenceMs?: number;
}

// why: the worker cuts an upload silent for the same 330 s, so the gateway's bound is the one the caller meets first.
const UPLOAD_SILENCE_MS = 330_000;

/** why: a gateway holds no file; it relays each file request to the worker that holds the lease, through the worker's `files` target (ADR 0067 §2). */
export function createGatewayLeaseFiles(options: GatewayLeaseFilesOptions): HttpLeaseFiles {
  return {
    handle: async (request, identity: Identity, lease, name) => {
      const declared = request.headers.get("content-length");
      if (name !== undefined && declared !== null && Number(declared) > MAX_FILE_BYTES) {
        return tooLarge(name);
      }
      const workerLeaseId = lease.workerLeaseId ?? lease.id;
      const relayed = await options.relay(lease.workerId ?? "", {
        leaseId: workerLeaseId,
        request: workerRequest(request, workerLeaseId, name),
        target: "files",
        tenant: `${options.requesterPrefix}${identity.principal}`,
        ...(request.method === "PUT" && name !== undefined
          ? { upload: { name, silenceMs: options.silenceMs ?? UPLOAD_SILENCE_MS } }
          : {}),
      });
      return withContentLength(await withCallersLeaseId(relayed, workerLeaseId, lease.id));
    },
  };
}

function tooLarge(name: string): Response {
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

function workerRequest(request: Request, workerLeaseId: string, name: string | undefined): Request {
  const path = `/files/leases/${encodeURIComponent(workerLeaseId)}${
    name === undefined ? "" : `/${encodeURIComponent(name)}`
  }`;
  return new Request(`http://simlock-worker${path}`, {
    headers: request.headers,
    method: request.method,
    signal: request.signal,
    ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
  } as RequestInit);
}

// why: the relay carries no `Content-Length`, so the worker sent the body's length under its own header and the gateway gives it back to the caller.
function withContentLength(answer: Response): Response {
  const length = answer.headers.get("simlock-content-length");
  if (length === null || !/^\d{1,16}$/.test(length)) return answer;
  const headers = new Headers(answer.headers);
  headers.set("content-length", length);
  return new Response(answer.body, { headers, status: answer.status });
}
