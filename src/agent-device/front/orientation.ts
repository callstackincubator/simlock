import type { Identity } from "../../auth/index.js";
import { isRotatableModel, parseOrientation } from "../../contract/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
import {
  failure,
  frontReply,
  markUnreachableAnswer,
  refusal,
  successReply,
  workerUnreachable,
} from "../shared/replies.js";
import type { RpcRead } from "../shared/rpc.js";
import { asRecord, commandName } from "../shared/selectors.js";
import type { FrontContext } from "./context.js";

type RpcRequest = RpcRead & { readonly kind: "request" };

export function isOrientationCall(read: RpcRequest): boolean {
  return commandName(asRecord(read.params)?.["command"]) === "orientation";
}

function typedName(read: RpcRequest): string {
  const positionals = asRecord(read.params)?.["positionals"];
  const first: unknown = Array.isArray(positionals) ? positionals[0] : undefined;
  return typeof first === "string" ? first : "";
}

// why: agent-device spells the two compound names with hyphens, and echoes the one it was asked for.
function agentDeviceName(orientation: string): string {
  return orientation.replaceAll("_", "-");
}

function unconfirmed(name: string) {
  return {
    action: "orientation",
    confirmed: false,
    message: `Rotation requested: ${name} (unconfirmed)`,
    orientation: name,
    warning: `Requested ${name}; the device owner reported no resulting orientation, so the rotation is unconfirmed.`,
  };
}

/**
 * why: agent-device's own rotation goes through its XCTest runner, which leaves taps missing; on an iOS phone or tablet simulator Simlock's input helper turns it instead. Undefined means the command is agent-device's to answer.
 */
export async function answerOrientation(
  context: FrontContext,
  identity: Identity,
  read: RpcRequest,
  leaseId: string,
): Promise<Response | undefined> {
  const held = context.map.get(leaseId);
  if (
    held === undefined ||
    held.identity.principal !== identity.principal ||
    held.platform !== "ios" ||
    held.model === undefined ||
    !isRotatableModel(held.model)
  ) {
    return undefined;
  }
  const typed = typedName(read);
  const parsed = parseOrientation(typed);
  if (!parsed.ok) return frontReply(refusal(parsed.message), read);
  try {
    await context.dispatch(
      "device.rotate",
      { leaseId, orientation: parsed.orientation },
      buildHttpSession(identity),
    );
  } catch (error) {
    if (mapError(error).code === "WORKER_UNREACHABLE") {
      return markUnreachableAnswer(frontReply(workerUnreachable(), read));
    }
    return frontReply(failure(error instanceof Error ? error.message : String(error)), read);
  }
  return successReply(unconfirmed(agentDeviceName(parsed.orientation)), read);
}
