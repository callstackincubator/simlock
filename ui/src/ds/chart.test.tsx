import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MinuteTable } from "./chart";

describe("the hidden minute table", () => {
  it("lists every minute of a chart and its count as text, newest first", () => {
    const minutes = [
      { at: 1, count: 0, label: "11:58" },
      { at: 2, count: 3, label: "11:59" },
      { at: 3, count: 1, label: "12:00" },
    ];

    const html = renderToStaticMarkup(<MinuteTable minutes={minutes} heading="Leases held" />);

    expect(html).toContain('<div class="visually-hidden"><table class="chart-data">');
    expect(html).not.toContain("<summary>");
    expect(html).toContain('<th scope="col" class="num">Leases held</th>');
    const rows = [...html.matchAll(/<tr><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)].map(
      ([, minute, count]) => `${minute} ${count}`,
    );
    expect(rows).toEqual(["12:00 1", "11:59 3", "11:58 0"]);
  });

  it("shows — for a bucket with no data, and names its time column by the bucket width", () => {
    const minutes = [
      { at: 1, count: null, label: "12:00" },
      { at: 2, count: 4, label: "12:05" },
    ];

    const columns = [60_000, 300_000, 3_600_000].map((bucketMs) => {
      const html = renderToStaticMarkup(
        <MinuteTable minutes={minutes} heading="Leases held" bucketMs={bucketMs} />,
      );
      return /<th scope="col">([^<]*)<\/th>/.exec(html)?.[1];
    });
    const html = renderToStaticMarkup(
      <MinuteTable minutes={minutes} heading="Leases held" bucketMs={300_000} />,
    );

    expect(columns).toEqual(["Minute", "Time", "Hour"]);
    const rows = [...html.matchAll(/<tr><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)].map(
      ([, bucket, count]) => `${bucket} ${count}`,
    );
    expect(rows).toEqual(["12:05 4", "12:00 —"]);
  });
});
