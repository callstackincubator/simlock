import type { UsageOutput } from "../../../src/contract/index";
import { type FiguresState, figuresOf } from "../model/figures";
import { type ConsoleRange, statsPath } from "../model/range";
export type { FiguresState } from "../model/figures";
import { useRef } from "react";

import { useLiveResource, useNow } from "./live";
import { loadView } from "./resource";

// why: the stats are their own read, not joined with the fleet's: a refused read hides only the
// figures it feeds.
export function useFigures(range: ConsoleRange): FiguresState {
  return useStats(range, figuresOf);
}

// why: the Overview and the Usage page read the same stats answer and map its states the same way;
// only the view model built from a ready answer differs.
export function useStats<T>(
  range: ConsoleRange,
  build: (output: UsageOutput, range: ConsoleRange, now: number) => T,
):
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T; readonly refusal?: string } {
  const view = loadView(useLiveResource<UsageOutput>(statsPath(range)));
  const now = useNow();
  // why: a new range is a new read; until it answers, the last answer stays drawn, so switching
  // the range does not swap every chart and tile for a loading note and back.
  const last = useRef<{ readonly kind: "ready"; readonly data: T; readonly refusal?: string }>(
    undefined,
  );
  if (view.kind === "loading") return last.current ?? view;
  if (view.kind === "unsupported") {
    return { kind: "refused", message: "Not available on a single host." };
  }
  if (view.kind === "refused") return view;
  const data = build(view.data, range, now.server);
  last.current =
    view.refusal === undefined
      ? { data, kind: "ready" }
      : { data, kind: "ready", refusal: view.refusal };
  return last.current;
}
