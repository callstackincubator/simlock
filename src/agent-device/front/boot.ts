import type { Identity } from "../../auth/index.js";
import { successReply } from "../shared/replies.js";
import type { RpcRead } from "../shared/rpc.js";
import type { FrontContext } from "./context.js";

export function answerBoot(
  context: FrontContext,
  identity: Identity,
  read: RpcRead & { readonly kind: "request" },
  leaseId: string | undefined,
): Response | undefined {
  const held = leaseId === undefined ? undefined : context.map.get(leaseId);
  if (held === undefined || held.identity.principal !== identity.principal) return undefined;
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
