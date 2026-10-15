import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { attentionPageOf } from "../../model/attention";
import type { WorkerView } from "../../model/workers";
import { AttentionBody } from ".";

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

function render(workers: readonly WorkerView[], key?: string): string {
  const page = attentionPageOf({ events: [], key, now: NOW, workers });
  return renderToStaticMarkup(<AttentionBody page={page} />);
}

describe("the attention screen", () => {
  it("says so when nothing needs attention", () => {
    const html = render([worker()]);

    expect(html).toContain("Nothing needs attention.");
    expect(html).toContain("0 open");
  });

  it("counts the open items and links each row to its item, with its condition as its name", () => {
    const html = render([
      worker({ connection: "disconnected", id: "wrk_a", label: "mac-mini-1" }),
      worker({ drained: true, id: "wrk_b" }),
    ]);

    expect(html).toContain("2 open");
    expect(html).toContain('aria-label="disconnected"');
    expect(html).toContain('href="/attention/wrk_a%2Fdisconnected"');
    expect(html).toContain('href="/attention/wrk_b%2Fdrained"');
  });

  it("shows the first item in the inspector with its worker linked and an Open worker button", () => {
    const html = render([worker({ drained: true, id: "wrk/1", label: "mac-mini-1" })]);

    expect(html).toContain("Leases still held");
    expect(html).toContain('href="/workers/wrk%2F1"');
    expect(html).toContain("Open worker");
    expect(html).toContain("Recent events");
    expect(html).toContain("No events in the last hour.");
  });

  it("says Resolved. with a link back when the URL names an item that no longer needs attention", () => {
    const html = render([worker()], "wrk_1/drained");

    expect(html).toContain("Resolved.");
    expect(html).toContain('<a href="/attention">Back to Attention</a>');
  });
});
