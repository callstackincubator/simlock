import { LEASE_ID_PATTERN, ERROR_TABLE } from "../contract/index.js";
import { LeaseFilesError } from "./errors.js";
import { handleRequest } from "./handler.js";
import type { LeaseFolders } from "./store.js";

const PATH = /^\/files\/leases\/([^/]+)(?:\/([^/]+))?$/;

/** why: the gateway names the worker's own lease id in the path, and the worker checks it as it checks any id from the wire. */
export function relayTarget(store: LeaseFolders): (request: Request) => Promise<Response> {
  return async (request) => {
    const match = PATH.exec(new URL(request.url).pathname);
    const [leaseId, name] = [match?.[1], match?.[2]].map((part) =>
      part === undefined ? undefined : decodeURIComponent(part),
    );
    if (leaseId === undefined || !LEASE_ID_PATTERN.test(leaseId)) {
      const refusal = new LeaseFilesError("BAD_REQUEST", "Not a lease files path", {});
      return Response.json(
        { error: { code: refusal.code, message: refusal.message } },
        { status: ERROR_TABLE[refusal.code].httpStatus },
      );
    }
    return handleRequest(store, request, { id: leaseId }, name);
  };
}
