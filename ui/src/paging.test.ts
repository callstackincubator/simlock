import { describe, expect, it } from "vitest";

import { lastPage, pageKeys, rangeOf, readPage, resized, TABLE_SIZES, writePage } from "./paging";

const KEYS = pageKeys();

describe("paging", () => {
  it("a query asking for a size the list does not offer, or a page that is not a whole number from 1, gets the defaults", () => {
    expect(readPage("?page=3&size=50", KEYS, TABLE_SIZES)).toEqual({ page: 3, size: 50 });
    expect(readPage("", KEYS, TABLE_SIZES)).toEqual({ page: 1, size: 25 });
    for (const page of ["0", "-2", "1.5", "two", ""]) {
      expect(readPage(`?page=${page}&size=50`, KEYS, TABLE_SIZES), page).toEqual({
        page: 1,
        size: 50,
      });
    }
    for (const size of ["33", "0", "fifty", ""]) {
      expect(readPage(`?page=3&size=${size}`, KEYS, TABLE_SIZES), size).toEqual({
        page: 3,
        size: 25,
      });
    }
  });

  it("each named list reads and writes its own keys, and leaves the rest of the query alone", () => {
    const devices = pageKeys("devices");
    const search = "?leases-page=3&devices-page=2";

    expect(readPage(search, devices, TABLE_SIZES)).toEqual({ page: 2, size: 25 });
    expect(writePage(search, devices, TABLE_SIZES, { page: 4, size: 100 })).toBe(
      "?leases-page=3&devices-page=4&devices-size=100",
    );
  });

  it("the first page and the default size are left out of the URL", () => {
    expect(writePage("?page=3&size=50", KEYS, TABLE_SIZES, { page: 1, size: 25 })).toBe("");
    expect(writePage("", KEYS, TABLE_SIZES, { page: 2, size: 25 })).toBe("?page=2");
  });

  it("an empty list has one page, and a partial page counts as one", () => {
    expect(lastPage(0, 25)).toBe(1);
    expect(lastPage(25, 25)).toBe(1);
    expect(lastPage(26, 25)).toBe(2);
    expect(lastPage(1_240, 25)).toBe(50);
  });

  it("a new page size keeps the first row shown in view", () => {
    // Rows 51 to 75 at 25 a page; at 50 a page, row 51 starts page 2.
    expect(resized({ page: 3, size: 25 }, 50)).toEqual({ page: 2, size: 50 });
    // Rows 101 to 200 at 100 a page; at 25 a page, row 101 starts page 5.
    expect(resized({ page: 2, size: 100 }, 25)).toEqual({ page: 5, size: 25 });
  });

  it("the range names the rows shown with thousands marked, and stops at the last row", () => {
    expect(rangeOf({ page: 1, size: 25 }, 1_240)).toBe("1–25 of 1,240");
    expect(rangeOf({ page: 50, size: 25 }, 1_240)).toBe("1,226–1,240 of 1,240");
  });
});
