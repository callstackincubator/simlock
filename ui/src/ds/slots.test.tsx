import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Slots } from "./index";

it("shows accessible state counts, squares through ten and a meter with a printed fraction above ten", () => {
  const slots = [
    { kind: "leased", label: "phone, leased" },
    { kind: "leased", label: "tablet, leased" },
    { kind: "absent", label: "phone, absent" },
    { kind: "broken", label: "phone, quarantined" },
    ...Array.from({ length: 16 }, () => ({ kind: "free", label: "free" }) as const),
  ] as const;
  for (const [count, label] of [
    [0, "No devices"],
    [10, "2 leased, 1 absent, 1 quarantined, 6 free"],
    [20, "2 leased, 1 absent, 1 quarantined, 16 free"],
  ] as const) {
    const html = renderToStaticMarkup(<Slots slots={slots.slice(0, count)} label={label} />);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html.match(/class="slot slot-/g) ?? []).toHaveLength(count <= 10 ? count : 0);
    if (count === 10) {
      expect(html).toContain('title="phone, absent"');
      expect(html).toContain('title="phone, quarantined"');
    }
    if (count === 20) {
      expect(html).toContain("2 / 20");
      expect(html).toContain('class="load-bar load-bar-neutral meter-regular"');
      expect(html).toContain("--load-bar:10%");
    }
  }
});
