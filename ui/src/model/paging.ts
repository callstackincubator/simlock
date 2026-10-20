export type PageSizes = readonly [number, ...number[]];

export const TABLE_SIZES: PageSizes = [25, 50, 100];

export interface PageKeys {
  readonly page: string;
  readonly size: string;
}

export function pageKeys(name?: string): PageKeys {
  return name === undefined
    ? { page: "page", size: "size" }
    : { page: `${name}-page`, size: `${name}-size` };
}

export interface PageAt {
  readonly page: number;
  readonly size: number;
}

// why: the query is editable by hand, so a size the list does not offer, or a page that is not a
// whole number from 1 up, falls back to the default.
export function readPage(search: string, keys: PageKeys, sizes: PageSizes): PageAt {
  const query = new URLSearchParams(search);
  const size = Number(query.get(keys.size));
  const page = Number(query.get(keys.page));
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    size: sizes.includes(size) ? size : sizes[0],
  };
}

export function lastPage(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

// why: the first page and the default size are left out, so a list that was never paged adds
// nothing to its URL.
export function writePage(search: string, keys: PageKeys, sizes: PageSizes, at: PageAt): string {
  const query = new URLSearchParams(search);
  if (at.page === 1) query.delete(keys.page);
  else query.set(keys.page, String(at.page));
  if (at.size === sizes[0]) query.delete(keys.size);
  else query.set(keys.size, String(at.size));
  const written = query.toString();
  return written === "" ? "" : `?${written}`;
}

export function resized(at: PageAt, size: number): PageAt {
  return { page: Math.floor(((at.page - 1) * at.size) / size) + 1, size };
}

const COUNT = new Intl.NumberFormat("en-US");

export function formatCount(count: number): string {
  return COUNT.format(count);
}

export function rangeOf(at: PageAt, total: number): string {
  const first = Math.min(total, (at.page - 1) * at.size + 1);
  const last = Math.min(total, at.page * at.size);
  return `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`;
}

// why: choosing a row must not throw the list back to its first page or its search, but the
// inspector's own pagers (devices, warm pool) belong to one worker and are left behind.
export function listSearch(search: string): string {
  const query = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of ["page", "size", "q"]) {
    const value = query.get(key);
    if (value !== null) kept.set(key, value);
  }
  const written = kept.toString();
  return written === "" ? "" : `?${written}`;
}

export function readQuery(search: string): string {
  return new URLSearchParams(search).get("q") ?? "";
}

// why: a new search starts at the first page, since the page the operator was on may not exist for
// it; the other keys of the query stay.
export function writeQuery(search: string, query: string): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  if (query === "") params.delete("q");
  else params.set("q", query);
  const written = params.toString();
  return written === "" ? "" : `?${written}`;
}
