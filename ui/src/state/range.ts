import { type ConsoleRange, readRange, writeRange } from "../model/range";
import { setSearch, useSearch } from "./router";

export { RANGE_CHOICES } from "../model/range";
export type { ConsoleRange } from "../model/range";

export function useRange(): readonly [ConsoleRange, (range: ConsoleRange) => void] {
  const search = useSearch();
  return [
    readRange(search),
    (range) => setSearch(writeRange(window.location.search, range), { replace: true }),
  ];
}
