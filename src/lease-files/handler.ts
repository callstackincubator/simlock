import type { LeaseFileStore } from "./lease-files.js";
import type { LeaseFilesLease } from "./types.js";

export async function handleRequest(
  store: LeaseFileStore,
  request: Request,
  lease: LeaseFilesLease,
  name: string | undefined,
): Promise<Response> {
  const grant = store.findGrant(lease.id);
  if (grant === undefined || name === undefined) return new Response(null, { status: 404 });
  if (request.method === "PUT") {
    const stored = await store.put(
      grant,
      name,
      request.body ?? new ReadableStream({ start: (c) => c.close() }),
    );
    return Response.json(stored, { status: 201 });
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
