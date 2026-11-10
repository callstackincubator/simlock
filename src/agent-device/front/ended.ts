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

function succeeded(text: string): boolean {
  return frames(text).some((frame) => {
    const line = asRecord(frame);
    const root = line?.["type"] === "response" ? asRecord(line["response"]) : line;
    return root?.["error"] === undefined && asRecord(root?.["result"])?.["ok"] === true;
  });
}

// why: after a restart agent-device's session for the lease is gone, and the session a later command makes holds no lease, so its `close` names none; the lease ends as a first session's close would, unless the entry asked to keep it (ADR 0071).
function closedLease(
  context: FrontContext,
  closing: string | undefined,
  text: string,
  ended: readonly string[],
): readonly string[] {
  if (closing === undefined || ended.includes(closing) || !succeeded(text)) return [];
  return context.map.get(closing)?.retainOnClose === true ? [] : [closing];
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
