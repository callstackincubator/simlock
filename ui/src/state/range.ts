import { type ConsoleRange, readRange, writeRange } from "../model/range";
import { setSearch, useSearch } from "./router";
import { useSettings } from "./settings";

export { RANGE_CHOICES } from "../model/range";
export type { ConsoleRange } from "../model/range";

export function useRange(): readonly [ConsoleRange, (range: ConsoleRange) => void] {
  const search = useSearch();
  // why: the operator's default range (Settings) is what a URL without `?range=` shows.
  const fallback = useSettings().range;
  return [
    readRange(search, fallback),
    (range) => setSearch(writeRange(window.location.search, range, fallback), { replace: true }),
  ];
}
