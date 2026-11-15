import { expect } from "vitest";
import { adminSession, type Envelope, type Rig } from "./test-support.js";

export async function waiting(
  rig: Rig,
): Promise<readonly { readonly id: string; readonly requesterId: string }[]> {
  return (await rig.daemon.dispatch("list.get", { kind: "requests" }, adminSession)) as never;
}

export const phoneModels = {
  defaultModels: { phone: ["iPhone 16"] },
  modelClasses: { "iPhone 16": "phone" },
} as const;

export const endedMessage = "lease ended by simlock; run disconnect, then open";

export function expectEndedBySimlock(answer: Envelope): void {
  expect(answer.result).toBeUndefined();
  expect(answer.error).toMatchObject({
    data: {
      code: "UNAUTHORIZED",
      details: { reason: "LEASE_ENDED_BY_HOST" },
      message: endedMessage,
      retriable: false,
    },
  });
}

export function expectLeaseGone(answer: Envelope, reason: string): void {
  expect(answer.error).toMatchObject({
    data: { code: "UNAUTHORIZED", details: { reason } },
  });
}
