import { describe, expect, it } from "vitest";

import type { UsageLedgerEntry } from "../contract/index.js";
import { ledgerCsv } from "./csv.js";

const entry = (over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry => ({
  outcome: "open",
  platform: "ios",
  probe: false,
  requestId: "req_1",
  requestedAt: Date.parse("2026-10-16T12:01:02.000Z"),
  requester: "tok_ci",
  ...over,
});

describe("ledger CSV", () => {
  it("quotes a field holding a comma, a quote, a CR or an LF, doubles its quotes, ends rows with CRLF, writes an empty cell for an absent value, and puts ' before a cell starting with =, +, - or @ (each of the four) and not before one starting otherwise", () => {
    const csv = ledgerCsv([
      entry({ requestId: "a,b", requester: 'say "hi"' }),
      entry({ requestId: "cr\rx", requester: "lf\nx" }),
      entry({ requestId: "=SUM(1)", requester: "+1" }),
      entry({ requestId: "-1", requester: "@home" }),
      entry({ requestId: "a=b", requester: "x-y" }),
      entry({ requestId: "=1,2", requester: "plain" }),
    ]);

    const tail = "ios,,,,2026-10-16T12:01:02.000Z,,,,,,,open,false,,";
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(8);
    expect(rows[7]).toBe("");
    expect(rows[1]).toBe(`"a,b","say ""hi""",,${tail}`);
    expect(rows[2]).toBe(`"cr\rx","lf\nx",,${tail}`);
    expect(rows[3]).toBe(`'=SUM(1),'+1,,${tail}`);
    expect(rows[4]).toBe(`'-1,'@home,,${tail}`);
    expect(rows[5]).toBe(`a=b,x-y,,${tail}`);
    expect(rows[6]).toBe(`"'=1,2",plain,,${tail}`);
  });

  it("prefixes an apostrophe to a cell whose first non-control, non-whitespace character is =, +, - or @", () => {
    const cases = [
      ["\u0000=1+1", "'\u0000=1+1"],
      ["\t=1", "'\t=1"],
      [" =1", "' =1"],
      ["\u001b@x", "'\u001b@x"],
      [" \u0000 +1", "' \u0000 +1"],
      ["\t1=1", "\t1=1"],
      ["  ", "  "],
    ] as const;
    const rows = ledgerCsv(cases.map(([model]) => entry({ model }))).split("\r\n");
    for (const [index, [model, cell]] of cases.entries()) {
      expect({ model, cell: rows[index + 1]?.split(",")[4] }).toEqual({ model, cell });
    }
  });

  it("writes a duration as whole milliseconds, rounding a fraction, and a time as ISO 8601 UTC", () => {
    const csv = ledgerCsv([entry({ heldMs: 507_600.4, turnaroundMs: 508_000.6, waitMs: 400 })]);

    expect(csv.split("\r\n")[1]).toBe(
      "req_1,tok_ci,,ios,,,,2026-10-16T12:01:02.000Z,,,,400,507600,508001,open,false,,",
    );
  });
});
