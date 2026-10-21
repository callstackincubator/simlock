import { describe, expect, it } from "vitest";

import { eventsPageQuery } from "./events-page.js";

describe("eventsPageQuery", () => {
  it("accepts 5, 500 and an id evt_a-B_9, and refuses 0, 501, 05, +5, ' 5', 5.0, 1e2, x, an id not-an-id, before with since, and limit with since, each with its message", () => {
    expect(eventsPageQuery({ limit: "5" })).toEqual({ page: { limit: 5 } });
    expect(eventsPageQuery({ limit: "500" })).toEqual({ page: { limit: 500 } });
    expect(eventsPageQuery({ before: "evt_a-B_9" })).toEqual({ page: { beforeId: "evt_a-B_9" } });
    expect(eventsPageQuery({ since: "1h" })).toEqual({ page: {} });

    const badLimit = { refused: "limit must be a whole number from 1 to 500" };
    for (const limit of ["0", "501", "05", "+5", " 5", "5.0", "1e2", "x", ""]) {
      expect(eventsPageQuery({ before: "evt_abc", limit })).toEqual(badLimit);
    }
    for (const before of ["not-an-id", "evt_", ""]) {
      expect(eventsPageQuery({ before })).toEqual({ refused: "before must be an event id" });
    }
    expect(eventsPageQuery({ before: "evt_abc", since: "1h" })).toEqual({
      refused: "before and since cannot be used together",
    });
    expect(eventsPageQuery({ limit: "50", since: "1h" })).toEqual({
      refused: "limit and since cannot be used together",
    });
  });
});
