import { ERROR_TABLE } from "../contract/index.js";
import { LeaseFilesError } from "./errors.js";
import type { LeaseFileStore } from "./lease-files.js";
import { requireFileName } from "./names.js";
import type { LeaseFilesLease } from "./types.js";

export async function handleRequest(
  store: LeaseFileStore,
  request: Request,
  lease: LeaseFilesLease,
  name: string | undefined,
): Promise<Response> {
  try {
    return await serve(store, request, lease, name);
  } catch (error: unknown) {
    if (!(error instanceof LeaseFilesError)) throw error;
    const refusal: LeaseFilesError = error;
    return Response.json(
      { error: { code: refusal.code, message: refusal.message, ...refusal.details } },
      { status: ERROR_TABLE[refusal.code].httpStatus },
    );
  }
}

async function serve(
  store: LeaseFileStore,
  request: Request,
  lease: LeaseFilesLease,
  name: string | undefined,
): Promise<Response> {
  const grant = store.findGrant(lease.id);
  if (grant === undefined || name === undefined) return new Response(null, { status: 404 });
  requireFileName(name);
  if (request.method === "PUT") {
    const body = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return Response.json(await store.put(grant, name, body, contentLengthOf(request)), {
      status: 201,
    });
  }
  const file = await store.openFile(grant, name);
  const length = String(file.size);
  return new Response(file.read(), {
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": length,
      "content-type": "application/octet-stream",
      "simlock-content-length": length,
    },
  });
}

function contentLengthOf(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^\d+$/.test(header)) {
    throw new LeaseFilesError("BAD_REQUEST", "Content-Length must be a non-negative integer", {});
  }
  return Number(header);
}
