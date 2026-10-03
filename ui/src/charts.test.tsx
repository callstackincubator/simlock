import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MinuteTable } from "./charts";

describe("the minute-by-minute table", () => {
  it("lists every minute of a chart and its count as text, newest first", () => {
    const minutes = [
      { at: 1, count: 0, label: "11:58" },
      { at: 2, count: 3, label: "11:59" },
      { at: 3, count: 1, label: "12:00" },
    ];

    const html = renderToStaticMarkup(<MinuteTable minutes={minutes} heading="Leases held" />);

    expect(html).toContain("<summary>Minute by minute</summary>");
    expect(html).toContain('<th scope="col" class="num">Leases held</th>');
    const rows = [...html.matchAll(/<tr><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)].map(
      ([, minute, count]) => `${minute} ${count}`,
    );
    expect(rows).toEqual(["12:00 1", "11:59 3", "11:58 0"]);
  });
});
