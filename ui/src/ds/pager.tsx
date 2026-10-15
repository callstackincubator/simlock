import "./pager.css";

import { Button } from "./button";

export interface Paging {
  readonly page: number;
  readonly size: number;
  readonly last: number;
  readonly total: number;
  readonly sizes: readonly number[];
  readonly range: string;
  readonly go: (page: number) => void;
  readonly resize: (size: number) => void;
}

// why: at either end the button that would leave the list stays in place and keeps focus for a
// keyboard, saying it is unavailable rather than vanishing.
export function Pager(props: { readonly label: string; readonly paging: Paging }) {
  const { label, paging } = props;
  const { go, last, page, range, resize, size, sizes, total } = paging;
  if (total <= size) return null;
  const first = page <= 1;
  const end = page >= last;
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <p className="pager-range">{range}</p>
      <label className="pager-size">
        Per page
        <select value={size} onChange={(event) => resize(Number(event.currentTarget.value))}>
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <div className="pager-steps">
        <Button
          aria-disabled={first}
          onClick={() => {
            if (!first) go(page - 1);
          }}
        >
          Previous
        </Button>
        <span className="pager-page">
          Page {page} of {last}
        </span>
        <Button
          aria-disabled={end}
          onClick={() => {
            if (!end) go(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
