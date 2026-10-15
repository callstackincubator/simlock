import { useEffect } from "react";

import type { Paging } from "../ds/pager";
import {
  lastPage,
  type PageAt,
  pageKeys,
  type PageSizes,
  rangeOf,
  readPage,
  resized,
  writePage,
} from "../model/paging";
import { setSearch, useSearch } from "./router";

export function usePaging(options: {
  readonly name?: string;
  readonly sizes: PageSizes;
  readonly total: number | undefined;
}): Paging {
  const { name, sizes } = options;
  const keys = pageKeys(name);
  const asked = readPage(useSearch(), keys, sizes);
  // why: before its data arrives a list has no length; correcting the page against zero rows would
  // throw away the page a reload or a shared link asked for.
  const total = options.total ?? 0;
  const last = options.total === undefined ? asked.page : lastPage(total, asked.size);
  const at = { page: Math.min(asked.page, last), size: asked.size };
  const moved = at.page !== asked.page;
  useEffect(() => {
    if (!moved) return;
    const corrected = { page: last, size: asked.size };
    setSearch(writePage(window.location.search, pageKeys(name), sizes, corrected), {
      replace: true,
    });
  }, [moved, last, asked.size, name, sizes]);
  const go = (to: PageAt) => setSearch(writePage(window.location.search, keys, sizes, to));
  return {
    go: (page) => go({ ...at, page }),
    last,
    page: at.page,
    range: rangeOf(at, total),
    resize: (size) => go(resized(at, size)),
    size: at.size,
    sizes,
    total,
  };
}
