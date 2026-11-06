import { ERROR_TABLE } from "../contract/index.js";
import { LeaseFilesError } from "./errors.js";
import { BodyCutError } from "./guarded-body.js";
import type { LeaseFolders } from "./store.js";
import { requireFileName } from "./names.js";
import { parseRange } from "./range.js";
import type { LeaseFileView, LeaseFilesLease } from "./types.js";

export async function handleRequest(
  store: LeaseFolders,
  request: Request,
  lease: LeaseFilesLease,
  name: string | undefined,
): Promise<Response> {
  try {
    return await serve(store, request, lease, name);
  } catch (error: unknown) {
    // why: a caller that went away mid-upload cannot be answered, and is no fault of the daemon's.
    if (error instanceof BodyCutError) return new Response(null, { status: 499 });
    if (!(error instanceof LeaseFilesError)) throw error;
    const refusal: LeaseFilesError = error;
    return Response.json(
      { error: { code: refusal.code, message: refusal.message, ...refusal.details } },
      { status: ERROR_TABLE[refusal.code].httpStatus },
    );
  }
}

async function serve(
  store: LeaseFolders,
  request: Request,
  lease: LeaseFilesLease,
  name: string | undefined,
): Promise<Response> {
  const grant = store.findGrant(lease.id);
  if (grant === undefined) {
    throw new LeaseFilesError("UNKNOWN_LEASE", `Unknown lease: ${lease.id}`, {
      leaseId: lease.id,
    });
  }
  if (name === undefined) return Response.json({ files: await store.list(grant) });
  requireFileName(name);
  if (request.method === "PUT") {
    const body = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return Response.json(await store.put(grant, name, body, contentLengthOf(request)), {
      status: 201,
    });
  }
  if (request.method === "DELETE") {
    await store.remove(grant, name);
    return new Response(null, { status: 204 });
  }
  return serveFile(request, await store.openFile(grant, name));
}

async function serveFile(request: Request, file: LeaseFileView): Promise<Response> {
  const answer = parseRange(request.headers.get("range"), file.size);
  if (answer.kind === "unsatisfiable") {
    await file.close();
    return new Response(null, {
      headers: { "content-range": `bytes */${String(file.size)}` },
      status: 416,
    });
  }
  const [start, end] = answer.kind === "range" ? [answer.start, answer.end] : [0, file.size - 1];
  const length = String(answer.kind === "range" ? end - start + 1 : file.size);
  return new Response(file.read(answer.kind === "range" ? { end, start } : undefined), {
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": length,
      ...(answer.kind === "range"
        ? { "content-range": `bytes ${String(start)}-${String(end)}/${String(file.size)}` }
        : {}),
      "content-type": "application/octet-stream",
      "simlock-content-length": length,
    },
    status: answer.kind === "range" ? 206 : 200,
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
