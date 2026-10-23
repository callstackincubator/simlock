import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { inboxItems } from "../../../../src/contract/inbox";
import { inboxPageOf } from "../../model/inbox";
import type { WorkerView } from "../../model/workers";
import { InboxBody } from ".";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

function render(workers: readonly WorkerView[]): string {
  const page = inboxPageOf({
    events: [],
    items: inboxItems(workers),
    key: undefined,
    now: NOW,
    workers,
  });
  return renderToStaticMarkup(<InboxBody rows={page.rows} filter="all" />);
}

describe("the Inbox screen", () => {
  it("says so when the Inbox is empty", () => {
    expect(render([worker()])).toContain("Nothing needs you.");
  });

  it("links each row to its item, with its condition as its name, under its group", () => {
    const html = render([
      worker({ connection: "disconnected", id: "wrk_a", label: "mac-mini-1" }),
      worker({ drained: true, id: "wrk_b" }),
    ]);

    expect(html).toContain("Broken");
    expect(html).toContain("Needs a look");
    expect(html).toContain('aria-label="disconnected"');
    expect(html).toContain('href="/inbox/wrk_a%2Fdisconnected"');
    expect(html).toContain('href="/inbox/wrk_b%2Fdrained"');
    expect(html.indexOf("Broken")).toBeLessThan(html.indexOf("Needs a look"));
  });
});
