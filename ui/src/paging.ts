/**
 * Paging a list in the browser: which page of it shows, read from and written to the page URL's
 * query, so a reload or a shared link opens the same page. Pure, so the rules stay tested; the
 * pager in `pager.tsx` wires them to the URL.
 */

/** The page sizes a list offers, smallest first. The first is the default. */
export type PageSizes = readonly [number, ...number[]];

/** Every table's sizes. */
export const TABLE_SIZES: PageSizes = [25, 50, 100];

/** The worker cards' sizes: whole rows of the card grid at two, three and four columns. */
export const CARD_SIZES: PageSizes = [24, 48, 96];

/** The query keys one list keeps its page and size in. */
export interface PageKeys {
  readonly page: string;
  readonly size: string;
}

/**
 * The keys of a list called `name`, or `page` and `size` for the one list a page has. Each list
 * on a page has its own name, so each keeps its own page.
 */
export function pageKeys(name?: string): PageKeys {
  return name === undefined
    ? { page: "page", size: "size" }
    : { page: `${name}-page`, size: `${name}-size` };
}

/** A page of a list: its number, counting from 1, and how many rows a page holds. */
export interface PageAt {
  readonly page: number;
  readonly size: number;
}

/**
 * The page the query asks for. A size the list does not offer is its default size, and a page
 * that is not a whole number from 1 up is the first page. The page may lie past the end of the
 * list; `lastPage` says where the list ends.
 */
export function readPage(search: string, keys: PageKeys, sizes: PageSizes): PageAt {
  const query = new URLSearchParams(search);
  const size = Number(query.get(keys.size));
  const page = Number(query.get(keys.page));
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    size: sizes.includes(size) ? size : sizes[0],
  };
}

/** The last page of `total` rows at `size` a page: 1 for an empty list. */
export function lastPage(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * `search` with the list's page and size set to `at`. The first page and the default size are
 * left out, so a list that was never paged adds nothing to its URL. Every other key is kept.
 */
export function writePage(search: string, keys: PageKeys, sizes: PageSizes, at: PageAt): string {
  const query = new URLSearchParams(search);
  if (at.page === 1) query.delete(keys.page);
  else query.set(keys.page, String(at.page));
  if (at.size === sizes[0]) query.delete(keys.size);
  else query.set(keys.size, String(at.size));
  const written = query.toString();
  return written === "" ? "" : `?${written}`;
}

/**
 * The page that keeps the first row shown in view when the size changes, as a pager moving from
 * 25 to 50 a page keeps the reader where they were.
 */
export function resized(at: PageAt, size: number): PageAt {
  return { page: Math.floor(((at.page - 1) * at.size) / size) + 1, size };
}

const COUNT = new Intl.NumberFormat("en-US");

/** A count with its thousands marked, such as `1,240`. */
export function formatCount(count: number): string {
  return COUNT.format(count);
}

/** Which rows a page shows of how many, such as `26–50 of 1,240`. */
export function rangeOf(at: PageAt, total: number): string {
  const first = Math.min(total, (at.page - 1) * at.size + 1);
  const last = Math.min(total, at.page * at.size);
  return `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`;
}
