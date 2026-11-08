import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Slot, Slots } from "./slots";

const many = (count: number): readonly Slot[] =>
  Array.from({ length: count }, () => ({ kind: "leased" as const, label: "leased" }));

// why: the cap on squares is a rule of this one component with several cases (none asked, ten, a hundred),
// so it is tested at the file.
describe("Slots", () => {
  it("draws a meter and a fraction unless squares are asked for", () => {
    const html = renderToStaticMarkup(<Slots slots={many(4)} label="4 leased" />);

    expect(html).toContain("slots-meter");
    expect(html).toContain("4 / 4");
    expect(html).not.toContain('class="slot ');
  });

  it("draws squares only when asked and only up to ten slots", () => {
    const few = renderToStaticMarkup(<Slots squares fraction slots={many(10)} label="x" />);
    const lots = renderToStaticMarkup(<Slots squares fraction slots={many(100)} label="x" />);

    expect(few.match(/class="slot /g)).toHaveLength(10);
    expect(few).toContain("10 / 10");
    expect(lots).not.toContain('class="slot ');
    expect(lots).toContain("100 / 100");
  });
});
