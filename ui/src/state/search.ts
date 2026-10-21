import { useCallback, useState } from "react";

import type { PaletteGroup } from "../ds";
import { leaseRows, type LeaseList, type TokenList } from "../model/leases";
import { buildResults, searchGroups } from "../model/search";
import { type WaitingList, waitingTable } from "../model/waiting";
import type { WorkerList } from "../model/workers";
import { useDaemonMode, useLiveResource, useNow } from "./live";
import { navigate } from "./router";

export interface SearchPalette {
  readonly open: boolean;
  readonly show: () => void;
  readonly hide: () => void;
}

export function useSearchPalette(): SearchPalette {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return { hide, open, show };
}

export interface SearchSession {
  readonly typed: string;
  readonly type: (typed: string) => void;
  readonly groups: readonly PaletteGroup[];
  readonly choose: (id: string) => void;
}

// why: the list is built once, when the dialog opens, from what the pages already read.
export function useSearchSession(
  pages: readonly { readonly label: string; readonly path: `/${string}` }[],
  hide: () => void,
): SearchSession {
  const workers = useLiveResource<WorkerList>("/v1/workers").data?.workers ?? [];
  const leases = useLiveResource<LeaseList>("/v1/leases").data?.leases ?? [];
  const tokens = useLiveResource<TokenList>("/v1/tokens").data?.tokens ?? [];
  const requests = useLiveResource<WaitingList>("/v1/lease-requests").data?.requests ?? [];
  const now = useNow();
  const mode = useDaemonMode();
  const [results] = useState(() =>
    buildResults({
      leases: leaseRows({ leases, now: now.server, tokens, workers }),
      mode,
      pages,
      requests: waitingTable(requests, workers, now.server).rows,
      workers,
    }),
  );
  const [typed, type] = useState("");
  return {
    choose: (id) => {
      const chosen = results.find((result) => result.id === id);
      hide();
      if (chosen !== undefined) navigate(chosen.to);
    },
    groups: searchGroups(results, typed).map((group) => ({
      items: group.results,
      name: group.name,
    })),
    type,
    typed,
  };
}
