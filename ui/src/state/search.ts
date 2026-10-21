import { useCallback, useEffect, useMemo, useState } from "react";

import type { ApiPath } from "../data/api";
import type { ResourceState } from "../data/live/connection";
import type { PaletteGroup } from "../ds";
import { leaseRows, type LeaseList, type TokenList } from "../model/leases";
import { buildResults, groupStatuses, searchGroups } from "../model/search";
import { type WaitingList, waitingTable } from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useActions } from "./actions";
import { useDaemonMode, useLiveResource, useNow } from "./live";
import { loadView } from "./resource";
import { navigate } from "./router";

export interface SearchPalette {
  readonly open: boolean;
  readonly show: () => void;
  readonly hide: () => void;
}

// why: a drawer or a dialog is already open over the console, and the search opens over none; a
// toast is a non-modal dialog and does not count.
const MODAL_DIALOG =
  '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]:not([aria-modal="false"])';

function isSearchChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

// why: ⌘K on a Mac and Ctrl+K elsewhere both open the search; the browser's own use of the chord is
// stopped while the console has focus.
export function useSearchPalette(): SearchPalette {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchChord(event)) return;
      event.preventDefault();
      if (document.querySelector(MODAL_DIALOG) === null) show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);
  return { hide, open, show };
}

export interface SearchSession {
  readonly typed: string;
  readonly type: (typed: string) => void;
  readonly groups: readonly PaletteGroup[];
  readonly empty: string;
  readonly choose: (id: string) => void;
}

type Source<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly data: T | undefined };

// why: a route a single host does not answer is not a failure to load; it lists nothing.
function sourceOf<T>(state: ResourceState<T>): Source<T> {
  const view = loadView(state);
  if (view.kind === "loading") return { kind: "loading" };
  if (view.kind === "refused") return { kind: "failed" };
  return { data: view.kind === "ready" ? view.data : undefined, kind: "ready" };
}

// why: a group already shown never changes while the dialog is open, so each read is kept as it
// stood the first time it settled, answered or failed; a live update after that changes nothing.
function useSettledOnce<T>(path: ApiPath): Source<T> {
  const live = sourceOf(useLiveResource<T>(path));
  const [kept, keep] = useState(live);
  if (kept.kind === "loading" && live.kind !== "loading") keep(live);
  return kept.kind === "loading" ? live : kept;
}

// why: a read that failed or has not answered lists nothing; the group says why.
function listOf<T, U>(source: Source<T>, pick: (data: T) => readonly U[]): readonly U[] {
  return source.kind === "ready" && source.data !== undefined ? pick(source.data) : [];
}

// why: the list is built when the dialog opens; a group that was loading fills in once its data
// arrives (the Actions only once every read they come from has settled), and then never changes.
export function useSearchSession(
  pages: readonly { readonly label: string; readonly path: `/${string}` }[],
  hide: () => void,
): SearchSession {
  const workers = useSettledOnce<WorkerList>("/v1/workers");
  const leases = useSettledOnce<LeaseList>("/v1/leases");
  const tokens = useSettledOnce<TokenList>("/v1/tokens");
  const requests = useSettledOnce<WaitingList>("/v1/lease-requests");
  const now = useNow();
  const [at] = useState(now.server);
  const mode = useDaemonMode();
  const { run } = useActions();
  const results = useMemo(() => {
    const workerList = listOf(workers, (data) => data.workers);
    return buildResults({
      leases: leaseRows({
        leases: listOf(leases, (data) => data.leases),
        now: at,
        tokens: listOf(tokens, (data) => data.tokens),
        workers: workerList,
      }),
      mode,
      pages,
      requests: waitingTable(
        listOf(requests, (data) => data.requests),
        workerList,
        at,
      ).rows,
      workers: workerList,
    });
  }, [at, leases, mode, pages, requests, tokens, workers]);
  const [typed, type] = useState("");
  const groups = searchGroups(
    results,
    typed,
    groupStatuses({
      leases: leases.kind,
      requests: requests.kind,
      tokens: tokens.kind,
      workers: workers.kind,
    }),
  );
  return {
    choose: (id) => {
      const chosen = results.find((result) => result.id === id);
      hide();
      if (chosen?.target.kind === "go") navigate(chosen.target.to);
      // why: the same runner as the ⋯ menus, so the confirm, the in-flight flag and the toast are theirs.
      else if (chosen !== undefined) void run(chosen.target.action);
    },
    empty: groups.length === 0 ? `No results for ${typed}` : "",
    groups: groups.map((group) => ({
      items: group.results,
      name: group.name,
      ...(group.note === undefined ? {} : { note: group.note }),
    })),
    type,
    typed,
  };
}
