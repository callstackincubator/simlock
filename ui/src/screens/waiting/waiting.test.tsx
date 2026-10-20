import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Paging } from "../../ds";
import { figuresOf, waitTile } from "../../model/figures";
import { statsOf } from "../../model/test-support";
import { chooseWaiting, type WaitingRequest, waitingTable } from "../../model/waiting";
import type { WaitingPage } from "../../state/waiting";
import { WaitingBody } from ".";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function request(overrides: Partial<WaitingRequest> = {}): WaitingRequest {
  return {
    createdAt: NOW - 75_000,
    id: "req_1",
    queuePosition: 1,
    requesterId: "agent-b",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
    ...overrides,
  };
}

const PAGING: Paging = {
  go: () => undefined,
  last: 1,
  page: 1,
  range: "1–1 of 1",
  resize: () => undefined,
  size: 25,
  sizes: [25, 50, 100],
  total: 1,
};

function pageOf(requests: readonly WaitingRequest[], id?: string): WaitingPage {
  const table = waitingTable(requests, [], NOW);
  return {
    ...chooseWaiting(table.rows, id, table.rows),
    count: table.rows.length,
    meta: table.meta,
    named: id !== undefined,
    paging: { ...PAGING, total: table.rows.length },
    rows: table.rows,
    wait: { kind: "loading" },
  };
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the Waiting screen", () => {
  it("leads each row with its place, then the requester, the time waited, the device and the stage", () => {
    const html = renderToStaticMarkup(<WaitingBody page={pageOf([request()])} />);

    expect(html).toContain('<ul class="list" aria-label="Waiting requests">');
    expect(html).toContain('href="/waiting/req_1"');
    expect(text(html)).toContain("#1 agent-b 1 min 15 s iOS iPhone 16 queued");
    expect(html).toContain('aria-label="queued"');
  });

  it("marks the first row as the chosen one when the URL names none, and the named one otherwise", () => {
    const two = [request({ id: "a" }), request({ id: "b", requesterId: "agent-c" })];

    const first = renderToStaticMarkup(<WaitingBody page={pageOf(two)} />);
    const second = renderToStaticMarkup(<WaitingBody page={pageOf(two, "b")} />);

    expect(first.match(/aria-current="page"/g)).toHaveLength(1);
    expect(first).toMatch(/aria-current="page"[^>]*>.*?agent-b/);
    expect(second).toMatch(/aria-current="page"[^>]*>.*?agent-c/);
    expect(second).toContain("focus-detail");
    expect(first).toContain("focus-list");
  });

  it("titles the inspector with the requester and says what it wants, with three cards and the facts", () => {
    const html = renderToStaticMarkup(<WaitingBody page={pageOf([request()])} />);

    expect(html).toMatch(/<h2[^>]*>agent-b<\/h2>/);
    expect(text(html)).toContain("wants iOS iPhone 16");
    expect(text(html)).toContain("Waiting 1 min 15 s");
    expect(text(html)).toContain("Place 1 of 1");
    expect(text(html)).toContain("Stage queued");
    expect(text(html)).toContain("Request req_1");
    expect(text(html)).toContain("Created 2026-10-02 11:58:45 UTC");
  });

  it("shows a Why fact after Queue with the reason's text, and none for a request that is starting", () => {
    const queued = request({
      reason: "platform-running-limit",
    } as unknown as Partial<WaitingRequest>);
    const starting = request({ stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;

    const withReason = text(renderToStaticMarkup(<WaitingBody page={pageOf([queued])} />));
    const without = text(renderToStaticMarkup(<WaitingBody page={pageOf([starting])} />));

    expect(withReason).toContain("Queue the gateway&#x27;s queue Why Full: running limit for iOS");
    expect(without).toContain("Stage starting");
    expect(without).not.toContain("Why");
  });

  it("links the worker whose queue holds the request, names the gateway's queue when none does, and the raw id of a worker it cannot see", () => {
    const onWorker = renderToStaticMarkup(
      <WaitingBody
        page={{
          ...pageOf([request()]),
          chosen: {
            ...pageOf([request()]).rows[0]!,
            queue: { kind: "worker", name: "worker-a", to: "/workers/wrk_1" },
          },
        }}
      />,
    );
    const onGateway = renderToStaticMarkup(<WaitingBody page={pageOf([request()])} />);
    const unseen = renderToStaticMarkup(
      <WaitingBody page={pageOf([request({ workerId: "wrk_gone" })])} />,
    );

    expect(onWorker).toContain('<a href="/workers/wrk_1">worker-a</a>');
    expect(text(onGateway)).toContain("Queue the gateway&#x27;s queue");
    expect(text(unseen)).toContain("Queue wrk_gone");
    expect(unseen).not.toContain("/workers/");
  });

  it("shows a request with no place in the queue as a dash in both the row and the card", () => {
    const starting = request({ stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;

    const html = renderToStaticMarkup(<WaitingBody page={pageOf([starting])} />);

    expect(text(html)).toContain("— agent-b");
    expect(text(html)).toContain("Place —");
  });

  it("says the request is in the physical queue when it is", () => {
    const physical = request({
      spec: { model: "iPhone 15 Pro", physical: true, platform: "ios" },
    } as unknown as Partial<WaitingRequest>);

    const html = renderToStaticMarkup(<WaitingBody page={pageOf([physical])} />);

    expect(text(html)).toContain("physical queue");
  });

  it("says so when nothing is waiting, and shows no inspector", () => {
    const html = renderToStaticMarkup(<WaitingBody page={pageOf([])} />);

    expect(text(html)).toContain("No requests are waiting.");
    expect(text(html)).toContain("0 waiting");
    expect(html).not.toContain("<h2");
  });

  it("says a named request is not waiting, with a link back to the list", () => {
    const html = renderToStaticMarkup(<WaitingBody page={pageOf([request()], "granted")} />);

    expect(text(html)).toContain("Request not waiting.");
    expect(html).toContain('<a href="/waiting">Back to waiting</a>');
    expect(html).not.toContain("<h2");
  });
});

describe("the Waiting inspector on a gateway", () => {
  it("shows one row per worker, labelled by the worker's name, with the reason's text", () => {
    const queued = request({
      workers: [
        { reason: "drained", workerId: "wrk_1" },
        { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_2" },
      ],
    });
    const table = waitingTable(
      [queued],
      [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: true,
          id: "wrk_1",
          label: "mac-mini-1",
          lastSeenAt: NOW,
          leases: [],
        },
      ],
      NOW,
    );
    const page: WaitingPage = {
      ...chooseWaiting(table.rows, undefined, table.rows),
      count: 1,
      meta: table.meta,
      named: false,
      paging: PAGING,
      rows: table.rows,
      wait: { kind: "loading" },
    };

    const body = text(renderToStaticMarkup(<WaitingBody page={page} />));

    expect(body).toContain("mac-mini-1 Drained");
    expect(body).toContain("wrk_2 Full: running limit for iOS");
  });

  it("shows the Wait p95 tile above its list with no range picker", () => {
    const stats = statsOf({ bucketMs: 60_000, from: NOW - 3_600_000, to: NOW, waitP95: 38_000 });
    const page = {
      ...pageOf([request()]),
      wait: { data: waitTile(stats, "1h"), kind: "ready" },
    } as const;

    const html = renderToStaticMarkup(<WaitingBody page={page} />);

    const shown = text(html);
    expect(shown).toContain("Wait p95 38 s last hour");
    expect(shown.indexOf("Wait p95")).toBeLessThan(shown.indexOf("agent-b"));
    expect(html).not.toContain('type="radio"');
    expect(figuresOf(stats, "1h", NOW).wait).toEqual(waitTile(stats, "1h"));
  });

  it("leaves the list as it was when the stats read is refused", () => {
    const page = {
      ...pageOf([request()]),
      wait: { kind: "refused", message: "The stats are not allowed." },
    } as const;

    const shown = text(renderToStaticMarkup(<WaitingBody page={page} />));

    expect(shown).toContain("The stats are not allowed.");
    expect(shown).toContain("#1 agent-b 1 min 15 s iOS iPhone 16 queued");
    expect(shown).not.toContain("Wait p95");
  });
});
