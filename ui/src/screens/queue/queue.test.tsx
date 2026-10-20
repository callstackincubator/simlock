import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Paging } from "../../ds";
import { figuresOf, waitTile } from "../../model/figures";
import { statsOf } from "../../model/test-support";
import { chooseWaiting, type WaitingRequest, waitingTable } from "../../model/waiting";
import type { WaitingPage } from "../../state/waiting";
import { QueueDrawerBody, QueueBody } from ".";

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
    ...chooseWaiting(table.rows, id),
    meta: table.meta,
    paging: { ...PAGING, total: table.rows.length },
    rows: table.rows,
    urlId: id,
    wait: { kind: "loading" },
  };
}

function table(page: WaitingPage): string {
  return renderToStaticMarkup(<QueueBody page={page} />);
}

function drawer(page: WaitingPage): string {
  return renderToStaticMarkup(<QueueDrawerBody page={page} />);
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the Queue table", () => {
  it("leads each row with its place, then the requester, the device, the stage, why and the time waited", () => {
    const html = table(pageOf([request({ reason: "device-limit" } as Partial<WaitingRequest>)]));

    expect(html).toContain('href="/queue/req_1"');
    expect(text(html)).toContain("Place Requester Device Stage Why Waited");
    expect(text(html)).toContain("#1 agent-b iOS iPhone 16 queued Full: device limit 1 min 15 s");
    expect(html).toContain('aria-label="queued"');
  });

  it("shows a request with no place in the queue as a dash", () => {
    const starting = request({ stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;

    expect(text(table(pageOf([starting])))).toContain("— agent-b");
  });

  it("says so when nothing is waiting", () => {
    expect(text(table(pageOf([])))).toContain("No requests are waiting.");
  });
});

describe("the Queue drawer", () => {
  it("says how long the request waited, its place, stage, device and queue, then the request and when it was created", () => {
    const html = text(drawer(pageOf([request()], "req_1")));

    expect(html).toContain("Waiting 1 min 15 s");
    expect(html).toContain("Place 1 of 1");
    expect(html).toContain("Stage queued");
    expect(html).toContain("Device iOS iPhone 16");
    expect(html).toContain("Request req_1");
    expect(html).toContain("Created 2026-10-02 11:58:45 UTC");
  });

  it("shows a Why fact after Queue with the reason's text, and none for a request that is starting", () => {
    const queued = request({
      reason: "platform-running-limit",
    } as unknown as Partial<WaitingRequest>);
    const starting = request({ stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;

    const withReason = text(drawer(pageOf([queued], "req_1")));
    const without = text(drawer(pageOf([starting], "req_1")));

    expect(withReason).toContain("Queue the gateway&#x27;s queue Why Full: running limit for iOS");
    expect(without).toContain("Stage starting");
    expect(without).not.toContain("Why");
  });

  it("links the worker whose queue holds the request, names the gateway's queue when none does, and the raw id of a worker it cannot see", () => {
    const base = pageOf([request()], "req_1");
    const onWorker = drawer({
      ...base,
      chosen: { ...base.rows[0]!, queue: { kind: "worker", name: "worker-a", to: "/fleet/wrk_1" } },
    });
    const onGateway = drawer(base);
    const unseen = drawer(pageOf([request({ workerId: "wrk_gone" })], "req_1"));

    expect(onWorker).toContain('<a href="/fleet/wrk_1">worker-a</a>');
    expect(text(onGateway)).toContain("Queue the gateway&#x27;s queue");
    expect(text(unseen)).toContain("Queue wrk_gone");
    expect(unseen).not.toContain("/fleet/");
  });

  it("says the request is in the physical queue when it is", () => {
    const physical = request({
      spec: { model: "iPhone 15 Pro", physical: true, platform: "ios" },
    } as unknown as Partial<WaitingRequest>);

    expect(text(drawer(pageOf([physical], "req_1")))).toContain("physical queue");
  });

  it("says a named request that no longer waits is not waiting", () => {
    expect(text(drawer(pageOf([request()], "granted")))).toContain("Request not waiting.");
  });
});

describe("the Queue drawer on a gateway", () => {
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
      ...chooseWaiting(table.rows, queued.id),
      meta: table.meta,
      paging: PAGING,
      rows: table.rows,
      urlId: queued.id,
      wait: { kind: "loading" },
    };

    const body = text(drawer(page));

    expect(body).toContain("mac-mini-1 Drained");
    expect(body).toContain("wrk_2 Full: running limit for iOS");
  });

  it("shows the Wait p95 tile above its list with no range picker", () => {
    const stats = statsOf({ bucketMs: 60_000, from: NOW - 3_600_000, to: NOW, waitP95: 38_000 });
    const page = {
      ...pageOf([request()]),
      wait: { data: waitTile(stats, "1h"), kind: "ready" },
    } as const;

    const html = table(page);

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

    const shown = text(table(page));

    expect(shown).toContain("The stats are not allowed.");
    expect(shown).toContain("#1 agent-b iOS iPhone 16 queued — 1 min 15 s");
    expect(shown).not.toContain("Wait p95");
  });
});
