import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usageFiguresOf, usageStatsFullOf } from "../../model/test-support";
import { type Answer, type Call, renderConsole } from "../../test/console";
import { NOW } from "../../test/fixtures";

const HOUR = 3_600_000;

function samples(count: number, p50: number, p95: number, max: number) {
  return { count, max, p50, p95 };
}

// why: the answer a daemon gives after one waiter, one --no-wait refusal and one grant, written by hand.
const SCRIPTED = usageFiguresOf({
  bySource: { booted: 1, provisioned: 0, warm: 1 },
  granted: 2,
  rejected: { byReason: { "no-wait": 1 }, total: 1 },
  requests: 3,
  utilisation: { slots: { max: 1, mean: 0.4, peak: 1 } },
  wait: samples(2, 1_000, 38_000, 40_000),
});

function stats(over = {}, since = HOUR) {
  return usageStatsFullOf({
    requesters: [
      { granted: 1, heldTotalMs: 60_000, id: "holder", requests: 1, rejected: 0 },
      { granted: 1, heldTotalMs: 20_000, id: "waiter", requests: 1, rejected: 0 },
      { granted: 0, heldTotalMs: 0, id: "refused", requests: 1, rejected: 1 },
    ],
    totals: SCRIPTED,
    window: { from: NOW - since, to: NOW },
    workers: [{ ...SCRIPTED, id: "wrk_1", label: "mac-studio-01" }],
    ...over,
  });
}

// why: a tile reads as one line, `<label> <value> <unit>`, as a screen reader hears it.
async function expectTile(label: string, value: string) {
  const tiles = within(await screen.findByRole("list", { name: "Usage figures" }));
  await waitFor(() =>
    expect(
      tiles.getAllByRole("listitem").find((item) => item.textContent?.startsWith(`${label} `)),
    ).toHaveTextContent(new RegExp(`^${label} ${value} (last|—)`)),
  );
}

function rowsOf(name: string) {
  return within(screen.getByRole("region", { name })).getAllByRole("row").slice(1);
}

function cellsOf(row: HTMLElement): readonly (string | null)[] {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent?.trim() ?? null);
}

function returnToTab() {
  const show = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  show("hidden");
  show("visible");
}

describe("the Usage page", () => {
  it("/usage?range=24h shows the requests, grants by source, rejections by reason, wait p95, slots peak and mean and requester rows of GET /v1/stats?since=24h, and its per-worker table has one row, the host", async () => {
    renderConsole({
      mode: "worker",
      path: "/usage?range=24h",
      routes: { "/v1/stats": { body: stats() } },
    });

    await screen.findByRole("heading", { level: 1, name: "Usage" });
    await expectTile("Requests", "3");
    await expectTile("Granted", "2");
    await expectTile("Rejected", "1");
    await expectTile("Wait p95", "38 s");
    expect(rowsOf("Grants by source").map(cellsOf)).toEqual([
      ["warm", "1"],
      ["booted", "1"],
      ["provisioned", "0"],
    ]);
    expect(rowsOf("Rejections by reason").map(cellsOf)).toEqual([["no-wait", "1"]]);
    expect(rowsOf("Use over the range").map(cellsOf)).toContainEqual([
      "Slots",
      "peak 1, mean 0.4, of 1",
    ]);
    const requesters = rowsOf("Per requester").map(cellsOf);
    expect(
      requesters.map(([name, requests, granted, rejected]) => [name, requests, granted, rejected]),
    ).toEqual([
      ["holder", "1", "1", "0"],
      ["waiter", "1", "1", "0"],
      ["refused", "1", "0", "1"],
    ]);
    expect(rowsOf("Per worker").map((row) => cellsOf(row)[0])).toEqual(["mac-studio-01"]);
  });

  it("/usage opens on 1 hour, choosing 7 days writes ?range=7d, and a reload keeps 7 days checked and the same figures", async () => {
    const answer = (call: Call): Answer => {
      const week = new URLSearchParams(call.search).get("since") === "7d";
      return {
        body: week ? stats({ totals: usageFiguresOf({ granted: 40, requests: 44 }) }) : stats(),
      };
    };
    const first = renderConsole({
      mode: "worker",
      path: "/usage",
      routes: { "/v1/stats": answer },
    });
    expect(await screen.findByRole("radio", { name: "1 hour" })).toBeChecked();

    await first.user.click(screen.getByRole("radio", { name: "7 days" }));

    expect(window.location.search).toBe("?range=7d");
    await expectTile("Requests", "44");
    first.unmount();
    renderConsole({ mode: "worker", path: "/usage?range=7d", routes: { "/v1/stats": answer } });
    expect(await screen.findByRole("radio", { name: "7 days" })).toBeChecked();
    await expectTile("Requests", "44");
    await expectTile("Granted", "40");
  });

  it("a lease granted while the page is open raises Requests and Granted without a reload", async () => {
    let figures = usageFiguresOf({ granted: 0, requests: 0 });
    renderConsole({
      mode: "worker",
      path: "/usage",
      routes: { "/v1/stats": () => ({ body: stats({ totals: figures }) }) },
    });
    await expectTile("Granted", "0");
    await expectTile("Requests", "0");

    figures = usageFiguresOf({ granted: 1, requests: 1 });
    returnToTab();

    await expectTile("Requests", "1");
    await expectTile("Granted", "1");
  });

  it("shows the Device slots in use chart in the shared frame", async () => {
    renderConsole({
      mode: "worker",
      path: "/usage?range=6h",
      routes: {
        "/v1/stats": {
          body: stats({
            series: [
              {
                at: NOW - 120_000,
                leasesHeld: 0,
                queueDepth: 0,
                slotsMax: null,
                slotsUsed: 1,
                waiting: null,
              },
              {
                at: NOW - 60_000,
                leasesHeld: 0,
                queueDepth: 0,
                slotsMax: null,
                slotsUsed: 2,
                waiting: null,
              },
            ],
          }),
        },
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Device slots in use, last 6 hours" }),
    ).toBeVisible();
    expect(screen.getAllByRole("table", { name: "Device slots in use" })).toHaveLength(1);
  });

  it("on a gateway with two workers, the per-worker table has two rows, each named by its worker's label", async () => {
    renderConsole({
      path: "/usage",
      routes: {
        "/v1/stats": {
          body: stats({
            workers: [
              { ...SCRIPTED, id: "wrk_a", label: "worker-a" },
              { ...SCRIPTED, id: "wrk_b", label: "worker-b" },
            ],
          }),
        },
      },
    });

    await screen.findByRole("region", { name: "Per worker" });
    await waitFor(() =>
      expect(rowsOf("Per worker").map((row) => cellsOf(row)[0])).toEqual(["worker-a", "worker-b"]),
    );
  });
});
