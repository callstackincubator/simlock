import type { TokenIdentity } from "../../http/token-store.js";
import { leaseIdOf } from "../shared/rpc.js";
import { asRecord } from "../shared/selectors.js";
import type { FrontContext } from "./context.js";
import { endSimlockLease } from "./release.js";

function idsIn(holder: unknown): string[] {
  const list = asRecord(holder)?.["endedLeases"];
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const item of list) {
    const id = leaseIdOf(asRecord(item)?.["leaseId"]);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

// why: agent-device names a lease it ended (a `close`) in `data` on success, in `error.details` on failure, which the JSON-RPC error carries as `error.data.details`; a streamed reply is one JSON frame per line, and any frame may carry it.
function idsInFrame(body: unknown): string[] {
  const root = asRecord(body);
  const error = asRecord(root?.["error"]);
  return [
    ...idsIn(asRecord(asRecord(root?.["result"])?.["data"])),
    ...idsIn(asRecord(asRecord(error?.["data"])?.["details"])),
  ];
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function endedLeaseIds(text: string): string[] {
  const whole = parsed(text);
  if (whole !== undefined) return idsInFrame(whole);
  return text.split("\n").flatMap((line) => idsInFrame(parsed(line)));
}

// why: the daemon no longer sends a release after it ends a lease, so the front ends the simlock lease from the command's reply; a copy is read so the CLI's reply goes out untouched.
export function releaseEndedLeases(
  context: FrontContext,
  identity: TokenIdentity,
  response: Response,
): void {
  if (!(response.headers.get("content-type") ?? "").includes("json")) return;
  void response
    .clone()
    .text()
    .then(async (text) => {
      for (const leaseId of new Set(endedLeaseIds(text))) {
        await endSimlockLease(context, identity, leaseId);
      }
    })
    .catch(() => undefined);
}
