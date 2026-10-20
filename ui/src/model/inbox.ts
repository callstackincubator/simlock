import type { AttentionItem, AttentionPage } from "./attention";
import type { ConsoleEvent } from "./events";
import type { WorkerView } from "./workers";

export type InboxItem = AttentionItem;
export type InboxPage = AttentionPage;

export function inboxItems(_workers: readonly WorkerView[]): readonly InboxItem[] {
  return [];
}

export function inboxPageOf(_input: {
  readonly workers: readonly WorkerView[];
  readonly events: readonly ConsoleEvent[];
  readonly now: number;
  readonly key: string | undefined;
}): InboxPage {
  return { named: false, rows: [], shown: undefined };
}
