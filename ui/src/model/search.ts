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
  readonly to: `/${string}`;
}

export interface SearchGroup {
  readonly name: SearchGroupName;
  readonly results: readonly SearchResult[];
}

export interface SearchInput {
  readonly pages: readonly { readonly label: string; readonly path: `/${string}` }[];
  readonly workers: readonly WorkerView[];
  readonly leases: readonly LeaseRowView[];
  readonly requests: readonly WaitingRow[];
}

export function buildResults(input: SearchInput): readonly SearchResult[] {
  return [
    ...input.pages.map(
      (page): SearchResult => ({
        group: "Pages",
        id: `page:${page.path}`,
        label: page.label,
        to: page.path,
      }),
    ),
    ...input.workers.map(
      (worker): SearchResult => ({
        group: "Workers",
        id: `worker:${worker.id}`,
        label: workerName(worker),
        to: workerPath(worker.id),
      }),
    ),
    ...input.workers.flatMap((worker) =>
      (worker.devices ?? []).map(
        (device): SearchResult => ({
          group: "Devices",
          id: `device:${worker.id}/${device.id}`,
          label: `${device.spec.model} · ${workerName(worker)}`,
          to: devicePath(worker.id, device.id),
        }),
      ),
    ),
    ...input.leases.map(
      (lease): SearchResult => ({
        group: "Leases",
        id: `lease:${lease.key}`,
        label: `${lease.holder} · ${lease.model}`,
        to: lease.to as `/${string}`,
      }),
    ),
    ...input.requests.map(
      (request): SearchResult => ({
        group: "Requests",
        id: `request:${request.key}`,
        label: `${request.requester} · ${request.device}`,
        to: request.to as `/${string}`,
      }),
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

export function searchGroups(
  results: readonly SearchResult[],
  typed: string,
): readonly SearchGroup[] {
  const words = wordsOf(typed);
  return SEARCH_GROUPS.map((name) => ({
    name,
    results: results.filter((result) => result.group === name && matches(result.label, words)),
  })).filter((group) => group.results.length > 0);
}
