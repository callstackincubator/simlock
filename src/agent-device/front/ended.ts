import type { Identity } from "../../auth/index.js";
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

// why: agent-device names a lease it ended (a `close`) in `data` on success, in `error.details` on failure, which the JSON-RPC error carries as `error.data.details`; a streamed reply is one JSON frame per line, and any frame may carry it, and without `--json` the CLI wraps the JSON-RPC answer as the `response` of a `type: "response"` line.
function idsInFrame(body: unknown): string[] {
  const line = asRecord(body);
  const root = line?.["type"] === "response" ? asRecord(line["response"]) : line;
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

function frames(text: string): unknown[] {
  const whole = parsed(text);
  if (whole !== undefined) return [whole];
  return text.split("\n").map((line) => parsed(line));
}

function endedLeaseIds(text: string): string[] {
  return frames(text).flatMap((frame) => idsInFrame(frame));
}

function closedSessionIn(data: Record<string, unknown> | undefined): boolean {
  if (typeof data?.["session"] === "string") return true;
  const results = data?.["results"];
  return (
    Array.isArray(results) &&
    results.some((step) => {
      const record = asRecord(step);
      return record?.["command"] === "close" && closedSessionIn(asRecord(record["data"]));
    })
  );
}

// why: agent-device names the session a close shut in its result's `data.session` (a failed close answers with an error, whose details may name the session it did not shut); a `close <app>` with no session open closes the app only and names none.
function closedSession(text: string): boolean {
  return frames(text).some((frame) => {
    const line = asRecord(frame);
    const root = line?.["type"] === "response" ? asRecord(line["response"]) : line;
    return closedSessionIn(asRecord(asRecord(root?.["result"])?.["data"]));
  });
}

// why: after agent-device forgot a lease, the front allocated it again, and the session a later command makes holds no lease, so its close names none; the lease ends as a first session's close would. Only a re-allocated entry is known to have lost agent-device's lease: an entry rebuilt after a gateway restart alone still has agent-device's, which keeps retainOnClose (ADR 0070 §2, ADR 0071).
function closedLease(
  context: FrontContext,
  closing: string | undefined,
  text: string,
  ended: readonly string[],
): readonly string[] {
  if (closing === undefined || ended.includes(closing)) return [];
  const entry = context.map.get(closing);
  if (entry?.restored !== true || entry.retainOnClose === true) return [];
  return closedSession(text) ? [closing] : [];
}

// why: the daemon no longer sends a release after it ends a lease, so the front ends the simlock lease from the command's reply; a copy is read so the CLI's reply goes out untouched.
export function releaseEndedLeases(
  context: FrontContext,
  identity: Identity,
  response: Response,
  closing?: string,
): void {
  if (!(response.headers.get("content-type") ?? "").includes("json")) return;
  void response
    .clone()
    .text()
    .then(async (text) => {
      const ended = endedLeaseIds(text);
      for (const leaseId of new Set([...ended, ...closedLease(context, closing, text, ended)])) {
        await endSimlockLease(context, identity, leaseId);
      }
    })
    .catch(() => undefined);
}
