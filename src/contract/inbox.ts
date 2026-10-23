import type {
  inboxItemSchema,
  statusLeaseSchema,
  tokenRecordSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./schemas.js";
import type { z } from "zod";

export type InboxItem = z.infer<typeof inboxItemSchema>;
export type WorkerView = z.infer<typeof workerViewSchema>;
export type LeaseRecord = z.infer<typeof statusLeaseSchema>;
export type TokenRecord = z.infer<typeof tokenRecordSchema>;
export type WaitingRequest = z.infer<typeof waitingRequestSchema>;

export interface InboxContext {
  readonly now: number;
  readonly requests?: readonly WaitingRequest[] | undefined;
  readonly leases?: readonly LeaseRecord[] | undefined;
  readonly tokens?: readonly TokenRecord[] | undefined;
}

export function inboxItems(
  _workers: readonly WorkerView[],
  _context?: InboxContext,
): readonly InboxItem[] {
  return [];
}
