import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TabBar } from "./shell";
import { VIEWS } from "./views/index";

/** Each tab as its path, its text, and whether it is marked current, in the order rendered. */
function tabs(html: string) {
  return [...html.matchAll(/<a([^>]*)>(.*?)<\/a>/g)].map(([, attributes = "", inner = ""]) => ({
    current: attributes.includes('aria-current="page"'),
    path: /href="([^"]*)"/.exec(attributes)?.[1],
    text: inner
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    count: /<span class="nav-count">(\d+)/.exec(inner)?.[1],
  }));
}

const attention = VIEWS.find((view) => view.path === "/attention");

describe("the tab bar", () => {
  it("the shell shows the five tabs and marks the current one", () => {
    const html = renderToStaticMarkup(<TabBar views={VIEWS} current={attention} counts={{}} />);

    expect(html).toContain('<nav class="tabs" aria-label="Console">');
    expect(tabs(html)).toEqual([
      { count: undefined, current: false, path: "/workers", text: "Workers" },
      { count: undefined, current: false, path: "/leases", text: "Leases" },
      { count: undefined, current: false, path: "/waiting", text: "Waiting" },
      { count: undefined, current: true, path: "/attention", text: "Attention" },
      { count: undefined, current: false, path: "/events", text: "Events" },
    ]);

    // A page no view has, such as a mistyped link, marks no tab.
    const none = renderToStaticMarkup(<TabBar views={VIEWS} current={undefined} counts={{}} />);
    expect(tabs(none).filter((tab) => tab.current)).toEqual([]);
  });

  it("the attention count shows on its tab and hides at zero", () => {
    const shown = tabs(
      renderToStaticMarkup(
        <TabBar views={VIEWS} current={VIEWS[0]} counts={{ "/attention": 2 }} />,
      ),
    );
    expect(shown.map((tab) => tab.count)).toEqual([
      undefined,
      undefined,
      undefined,
      "2",
      undefined,
    ]);
    // A screen reader hears what the number counts.
    expect(shown[3]?.text).toBe("Attention 2 items");

    const one = tabs(
      renderToStaticMarkup(
        <TabBar views={VIEWS} current={VIEWS[0]} counts={{ "/attention": 1 }} />,
      ),
    );
    expect(one[3]?.text).toBe("Attention 1 item");

    for (const count of [0, undefined]) {
      const hidden = renderToStaticMarkup(
        <TabBar views={VIEWS} current={VIEWS[0]} counts={{ "/attention": count }} />,
      );
      expect(hidden).not.toContain("nav-count");
      expect(tabs(hidden)[3]?.text).toBe("Attention");
    }
  });
});
