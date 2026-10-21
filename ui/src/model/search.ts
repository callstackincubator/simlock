import {
  type DaemonModeName,
  type ItemAction,
  leaseActions,
  requestActions,
  workerActions,
} from "./actions";
import type { LeaseRowView } from "./leases";
import { devicePath } from "./paths";
import type { WaitingRow } from "./waiting";
import { type WorkerView, workerName, workerPath } from "./workers";

export const SEARCH_GROUPS = [
  "Pages",
  "Workers",
  "Devices",
  "Leases",
  "Requests",
  "Actions",
] as const;
export type SearchGroupName = (typeof SEARCH_GROUPS)[number];

export interface SearchResult {
  readonly id: string;
  readonly group: SearchGroupName;
  readonly label: string;
  readonly target: SearchTarget;
}

export type SearchTarget =
  | { readonly kind: "go"; readonly to: `/${string}` }
  | { readonly kind: "run"; readonly action: ItemAction };

export type GroupStatus = "loading" | "failed";

export interface SearchGroup {
  readonly name: SearchGroupName;
  readonly results: readonly SearchResult[];
  readonly note?: string;
}

export interface SearchInput {
  readonly pages: readonly { readonly label: string; readonly path: `/${string}` }[];
  readonly workers: readonly WorkerView[];
  readonly leases: readonly LeaseRowView[];
  readonly requests: readonly WaitingRow[];
  readonly mode: DaemonModeName | undefined;
}

export function buildResults(input: SearchInput): readonly SearchResult[] {
  return [
    ...input.pages.map(
      (page): SearchResult => ({
        group: "Pages",
        id: `page:${page.path}`,
        label: page.label,
        target: { kind: "go", to: page.path },
      }),
    ),
    ...input.workers.map(
      (worker): SearchResult => ({
        group: "Workers",
        id: `worker:${worker.id}`,
        label: workerName(worker),
        target: { kind: "go", to: workerPath(worker.id) },
      }),
    ),
    ...input.workers.flatMap((worker) =>
      (worker.devices ?? []).map(
        (device): SearchResult => ({
          group: "Devices",
          id: `device:${worker.id}/${device.id}`,
          label: `${device.spec.model} · ${workerName(worker)}`,
          target: { kind: "go", to: devicePath(worker.id, device.id) },
        }),
      ),
    ),
    ...input.leases.map(
      (lease): SearchResult => ({
        group: "Leases",
        id: `lease:${lease.key}`,
        label: `${lease.holder} · ${lease.model}`,
        target: { kind: "go", to: lease.to as `/${string}` },
      }),
    ),
    ...input.requests.map(
      (request): SearchResult => ({
        group: "Requests",
        id: `request:${request.key}`,
        label: `${request.requester} · ${request.device}`,
        target: { kind: "go", to: request.to as `/${string}` },
      }),
    ),
    ...actionResults(input),
  ];
}

function actionResult(action: ItemAction, item: string): SearchResult {
  return {
    group: "Actions",
    id: `action:${action.itemKey}:${action.id}`,
    label: `${action.label} — ${item}`,
    target: { action, kind: "run" },
  };
}

// why: the actions are the ones the ⋯ menus offer, read from the same list (ADR 0037 §3); an Inbox
// item adds none, since its actions are the same actions on the same worker, lease or request.
function actionResults(input: SearchInput): readonly SearchResult[] {
  return [
    ...input.workers.flatMap((worker) =>
      workerActions(
        {
          connection: worker.connection,
          drained: worker.drained,
          id: worker.id,
          name: workerName(worker),
        },
        input.mode,
      ).map((action) => actionResult(action, workerName(worker))),
    ),
    ...input.leases.flatMap((lease) =>
      leaseActions(lease).map((action) => actionResult(action, `${lease.holder} · ${lease.model}`)),
    ),
    ...input.requests.flatMap((request) =>
      requestActions(request).map((action) =>
        actionResult(action, `${request.requester} · ${request.device}`),
      ),
    ),
  ];
}

// why: a label and what is typed are both cut into words at spaces, `·` and `—`, so a pasted
// label still matches and `mac-studio-2` stays one word.
function wordsOf(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[\s·—]+/)
    .filter((word) => word !== "");
}

function matches(label: string, typed: readonly string[]): boolean {
  const words = wordsOf(label);
  return typed.every((word) => words.some((candidate) => candidate.startsWith(word)));
}

// why: a result whose every typed word is a whole word of its label ranks before one that only
// starts with them, so `drain mac-studio-2` finds mac-studio-2 before mac-studio-20.
function isExact(label: string, typed: readonly string[]): boolean {
  const words = wordsOf(label);
  return typed.every((word) => words.includes(word));
}

export function searchGroups(
  results: readonly SearchResult[],
  typed: string,
  statuses: Partial<Record<SearchGroupName, GroupStatus>> = {},
): readonly SearchGroup[] {
  const words = wordsOf(typed);
  if (words.length === 0) {
    return [{ name: "Pages", results: results.filter((result) => result.group === "Pages") }];
  }
  return SEARCH_GROUPS.flatMap((name): SearchGroup[] => {
    const found = results
      .filter((result) => result.group === name && matches(result.label, words))
      .sort(
        (a, b) =>
          Number(isExact(b.label, words)) - Number(isExact(a.label, words)) ||
          a.label.localeCompare(b.label, "en"),
      );
    const status = statuses[name];
    if (status !== undefined) {
      const note = status === "loading" ? "Loading…" : `Could not load ${name.toLowerCase()}.`;
      return [{ name, note, results: found }];
    }
    return found.length === 0 ? [] : [{ name, results: found }];
  });
}
