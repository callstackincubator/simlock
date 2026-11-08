import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SETTING_DEFAULTS } from "../../model/settings";
import { SettingsBody } from "./index";

const console = {
  change: () => undefined,
  setSidebarCollapsed: () => undefined,
  settings: SETTING_DEFAULTS,
  sidebarCollapsed: false,
};

function render(daemon: Parameters<typeof SettingsBody>[0]["daemon"]): string {
  return renderToStaticMarkup(
    <SettingsBody console={console} daemon={daemon} copy={() => undefined} />,
  );
}

describe("the Settings page", () => {
  it("shows the console choices and the daemon's settings by section, with a copy button per key", () => {
    const html = render({
      kind: "view",
      view: {
        data: [
          {
            entries: [{ key: "lease.defaultTtlMs", masked: false, value: "600000" }],
            name: "lease",
          },
          {
            entries: [{ key: "gateway.token", masked: true, value: "[redacted]" }],
            name: "gateway",
          },
        ],
        kind: "ready",
      },
    });

    expect(html).toContain("Settings");
    for (const label of ["Theme", "Sidebar", "Default range", "Rows per page", "Holder ids"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("simlock config set &lt;key&gt; &lt;value&gt;");
    expect(html).toContain("lease.defaultTtlMs");
    expect(html).toContain("600000");
    expect(html).toContain("[redacted]");
    expect(html.match(/Copy the command to set/g)).toHaveLength(1);
  });

  it("says so when the token cannot read the config", () => {
    expect(render({ kind: "forbidden" })).toContain(
      "Your token cannot read this daemon&#x27;s settings.",
    );
  });

  it("says it is loading and reports an empty config", () => {
    expect(render({ kind: "view", view: { kind: "loading" } })).toContain("Loading");
    expect(render({ kind: "view", view: { data: [], kind: "ready" } })).toContain(
      "reports no settings",
    );
  });
});
