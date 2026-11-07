import type { Identity } from "../../auth/index.js";
import { frontReply, leaseEndedByHost, refusal, successReply } from "../shared/replies.js";
import type { RpcRead } from "../shared/rpc.js";
import { asRecord } from "../shared/selectors.js";
import type { FrontContext } from "./context.js";

export function answerBoot(
  context: FrontContext,
  identity: Identity,
  read: RpcRead & { readonly kind: "request" },
  leaseId: string | undefined,
): Response {
  const held = leaseId === undefined ? undefined : context.map.get(leaseId);
  if (leaseId === undefined)
    return frontReply(refusal("refused: boot names no lease; open a device first"), read);
  if (held === undefined || held.identity.principal !== identity.principal)
    return frontReply(refusal("refused: simlock picks the device"), read);
  if (held.endedBy === "simlock") return frontReply(leaseEndedByHost(), read);
  if (held.endedBy === "agent")
    return frontReply(refusal("refused: this lease has ended; open a device"), read);
  const params = asRecord(read.params);
  for (const key of ["flags", "input", "runtime"]) {
    const platform = asRecord(params?.[key])?.["platform"];
    if (platform != null && platform !== held.platform)
      return frontReply(refusal("refused: simlock picks the device"), read);
  }
  return successReply(
    {
      platform: held.platform,
      target: held.bootTarget ?? "mobile",
      device: held.name ?? held.model,
      id: held.address,
      kind: held.physical ? "device" : held.platform === "android" ? "emulator" : "simulator",
      booted: true,
    },
    read,
  );
}
