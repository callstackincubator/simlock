/**
 * The pager under a long list, and the page it shows, kept in the page URL's query
 * (`?page=3&size=50`) so a reload or a shared link opens the same page.
 */
import { useEffect } from "react";

import {
  lastPage,
  type PageAt,
  pageKeys,
  type PageSizes,
  rangeOf,
  readPage,
  resized,
  writePage,
} from "./paging";
import { setSearch, useSearch } from "./router";

/** Where a list is, and how to move it. */
export interface Paging {
  /** The page shown: never past the last page. */
  readonly at: PageAt;
  /** How many rows the whole list has. */
  readonly total: number;
  readonly sizes: PageSizes;
  /** The number of the last page. */
  readonly last: number;
  /** Shows `to`, and writes it to the URL as a new history entry. */
  readonly go: (to: PageAt) => void;
}

/**
 * The page of a list of `total` rows that the URL asks for. A list keeps its page under its own
 * `name` (see `pageKeys`), so two lists on one page move apart. When the list shrinks below the
 * page asked for, the last page shows, and the URL is corrected to say so.
 */
export function usePaging(options: {
  readonly name?: string;
  readonly sizes: PageSizes;
  readonly total: number;
}): Paging {
  const { name, sizes, total } = options;
  const keys = pageKeys(name);
  const asked = readPage(useSearch(), keys, sizes);
  const last = lastPage(total, asked.size);
  const at = { page: Math.min(asked.page, last), size: asked.size };
  const moved = at.page !== asked.page;
  useEffect(() => {
    if (!moved) return;
    const corrected = { page: last, size: asked.size };
    setSearch(writePage(window.location.search, pageKeys(name), sizes, corrected), {
      replace: true,
    });
  }, [moved, last, asked.size, name, sizes]);
  return {
    at,
    go: (to) => setSearch(writePage(window.location.search, keys, sizes, to)),
    last,
    sizes,
    total,
  };
}

/**
 * The pager under a list: which rows show of how many ("1–25 of 1,240"), the page size, and
 * previous and next with the page number between them. Hidden when the whole list fits on the
 * page. At either end the button that would leave the list says it is unavailable and does
 * nothing, but keeps its place, so focus stays put for a keyboard. Every list, a table or the
 * worker cards, moves by these rules alone: a page at a time, and to a new size at the page
 * that keeps its first row in view.
 */
export function Pager(props: {
  /** What the list is, to name the pager: "All leases" makes "All leases pages". */
  readonly label: string;
  readonly paging: Paging;
}) {
  const { label, paging } = props;
  const { at, go, last, sizes, total } = paging;
  if (total <= at.size) return null;
  const first = at.page <= 1;
  const end = at.page >= last;
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <p className="pager-range">{rangeOf(at, total)}</p>
      <label className="pager-size">
        Per page
        <select
          value={at.size}
          onChange={(event) => go(resized(at, Number(event.currentTarget.value)))}
        >
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="pager-steps">
        <button
          className="button button-secondary"
          type="button"
          aria-disabled={first}
          onClick={() => {
            if (!first) go({ ...at, page: at.page - 1 });
          }}
        >
          Previous
        </button>
        <span className="pager-page">
          Page {at.page} of {last}
        </span>
        <button
          className="button button-secondary"
          type="button"
          aria-disabled={end}
          onClick={() => {
            if (!end) go({ ...at, page: at.page + 1 });
          }}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
