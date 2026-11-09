import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { statsOf, usageStatsFullOf } from "../../model/test-support";
import { type Answer, type Call, renderConsole } from "../../test/console";
import { device, event, lease, NOW, request, token, worker, workerItem } from "../../test/fixtures";

const HOUR = 3_600_000;

const RANGES = [
  {
    held: [1, 2, 2],
    label: "1 h",
    ms: HOUR,
    p95: 38_000,
    queued: [0, 1, null],
    since: "1h",
    unit: "last hour",
    wait: "38 s",
  },
  {
    held: [3, 4, 5],
    label: "6 h",
    ms: 6 * HOUR,
    p95: 130_000,
    queued: [2, 0, 1],
    since: "6h",
    unit: "last 6 hours",
    wait: "2 min 10 s",
  },
  {
    held: [6, 0, 7],
    label: "24 h",
    ms: 24 * HOUR,
    p95: 450,
    queued: [1, 1, 3],
    since: "24h",
    unit: "last 24 hours",
    wait: "450 ms",
  },
  {
    held: [8, 9, 1],
    label: "7 d",
    ms: 168 * HOUR,
    p95: null,
    queued: [4, 0, 2],
    since: "7d",
    unit: "last 7 days",
    wait: "—",
  },
] as const;

// why: the stats answer for a range, written by hand: a Wait p95 and three buckets of each chart.
function statsAnswer(call: Call): Answer {
  const since = new URLSearchParams(call.search).get("since") ?? "1h";
  const range = RANGES.find((entry) => entry.since === since) ?? RANGES[0];
  const from = NOW - range.ms;
  return {
    body: statsOf({
      bucketMs: 60_000,
      from,
      series: range.held.map((held, index) => ({
        at: from + index * 60_000,
        leasesHeld: held,
        queueDepth: range.queued[index] ?? null,
        slotsUsed: null,
      })),
      to: NOW,
      waitP95: range.p95,
    }),
  };
}

const STATS = { "/v1/stats": statsAnswer };
// why: the Usage page reads every figure of the stats answer, and a tile opens it.
const FULL_STATS = { "/v1/stats": { body: usageStatsFullOf() } };

function tiles() {
  return within(screen.getByRole("list", { name: "Fleet at a glance" }));
}

function tile(label: string) {
  return tiles().getByRole("link", { name: new RegExp(`^${label}\\b`) });
}

function countsOf(name: string): readonly string[] {
  const table = screen.getByRole("table", { name });
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[1]?.textContent ?? "");
}

function shown(values: readonly (number | null)[]): readonly string[] {
  return values.toReversed().map((value) => (value === null ? "—" : String(value)));
}

const ONE_HOST = worker({
  devices: [device()],
  leases: [],
});

describe("the Overview's figures", () => {
  it("picking each of 1 h, 6 h, 24 h and 7 d writes its ?range=, and the Wait p95 tile and the two chart tables equal GET /v1/stats", async () => {
    const { user } = renderConsole({
      mode: "worker",
      routes: { ...STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
    });
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    for (const range of RANGES) {
      await user.click(await screen.findByRole("radio", { name: range.label }));
      expect(screen.getByRole("radio", { name: range.label })).toBeChecked();
      expect(window.location.search).toBe(range.since === "1h" ? "" : `?range=${range.since}`);
      expect(
        await screen.findByRole("heading", { name: `Requests waiting · ${range.label}` }),
      ).toBeVisible();
      await waitFor(() =>
        expect(tile("Wait p95")).toHaveAccessibleName(`Wait p95 ${range.wait} ${range.unit}`),
      );
      await waitFor(() => expect(countsOf("Leases held")).toEqual(shown(range.held)));
      expect(countsOf("Requests in the queue")).toEqual(shown(range.queued));
    }
  });

  it("a reload of /?range=6h keeps 6 h checked and the same tile numbers", async () => {
    renderConsole({
      mode: "worker",
      path: "/?range=6h",
      routes: { ...STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
    });

    expect(await screen.findByRole("radio", { name: "6 h" })).toBeChecked();
    await waitFor(() =>
      expect(tile("Wait p95")).toHaveAccessibleName("Wait p95 2 min 10 s last 6 hours"),
    );
  });
});

describe("the Overview's live figures", () => {
  it("a lease granted while the Overview is open raises Leased without a reload", async () => {
    let workers = [ONE_HOST];
    const { events } = renderConsole({
      mode: "worker",
      routes: { ...STATS, "/v1/workers": () => ({ body: { workers } }) },
    });
    await waitFor(() => expect(tile("Leased")).toHaveTextContent("0"));

    workers = [
      worker({
        devices: [device({ state: "leased" })],
        leases: [lease({ requesterId: "late" })],
      }),
    ];
    events.push("lease.granted", event("lease.granted", { leaseId: "lse_1" }));

    await waitFor(() => expect(tile("Leased")).toHaveAccessibleName("Leased 1 / 1"));
  });
});

describe("the Overview on a single host", () => {
  it("shows all six numbers, the worker table and both charts", async () => {
    renderConsole({
      mode: "worker",
      routes: { ...STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
    });
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    await waitFor(() => expect(tile("Leased")).toHaveAccessibleName("Leased 0 / 1"));
    expect(tile("Ready")).toHaveAccessibleName("Ready 1 warm");
    expect(tile("Workers")).toHaveAccessibleName("Workers 1 / 1");
    expect(tile("Waiting")).toHaveAccessibleName("Waiting 0 none");
    expect(tile("Ending soon")).toHaveAccessibleName("Ending soon 0 < 5 min");
    expect(tile("Wait p95")).toBeVisible();
    expect(await screen.findByRole("region", { name: "Leases held" })).toBeVisible();
    expect(screen.getByRole("heading", { name: /^Requests waiting/ })).toBeVisible();
    const wall = screen.getByRole("region", { name: "Fleet" });
    expect(within(wall).getAllByRole("link", { name: "mac-studio-01" })).toHaveLength(1);
    expect(within(wall).getAllByRole("table")).toHaveLength(1);
    expect(
      screen.getAllByRole("table").map((table) => table.querySelector("caption")?.textContent),
    ).toEqual([undefined, "Leases held", "Requests in the queue"]);
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
  });
});

describe("the Overview's links", () => {
  it("each KPI tile opens its page, and Wait p95 keeps the chosen range, at 1 h and at 6 h, 24 h and 7 d", async () => {
    const destinations = [
      ["Leased", "/leases"],
      ["Ready", "/fleet"],
      ["Waiting", "/queue"],
      ["Wait p95", "/usage"],
      ["Ending soon", "/leases"],
      ["Workers", "/fleet"],
    ] as const;
    for (const range of ["", "?range=6h", "?range=24h", "?range=7d"]) {
      const { unmount } = renderConsole({
        mode: "worker",
        path: `/${range}`,
        routes: { ...FULL_STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
      });
      await screen.findByRole("heading", { level: 1, name: "Overview" });
      for (const [label, path] of destinations) {
        // why: only Wait p95 carries the range; the other pages have no range of their own.
        const href = label === "Wait p95" ? `${path}${range}` : path;
        await waitFor(() => expect(tile(label), `${label} ${range}`).toHaveAttribute("href", href));
      }
      unmount();
    }

    const { user } = renderConsole({
      mode: "worker",
      routes: { ...FULL_STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
    });
    await user.click(await screen.findByRole("radio", { name: "6 h" }));
    await user.click(tile("Wait p95"));
    await waitFor(() =>
      expect(`${window.location.pathname}${window.location.search}`).toBe("/usage?range=6h"),
    );
  });

  it("Overview's tiles and links land on /queue and /fleet, not Not found", async () => {
    const links = [
      { follow: () => tile("Waiting"), heading: "Queue", path: "/queue" },
      { follow: () => tile("Workers"), heading: "Fleet", path: "/fleet" },
      {
        follow: () => screen.getByRole("link", { name: "Open fleet" }),
        heading: "Fleet",
        path: "/fleet",
      },
      {
        follow: () =>
          within(screen.getByRole("region", { name: "Fleet" })).getByRole("link", {
            name: "mac-studio-01",
          }),
        heading: "Fleet / mac-studio-01",
        path: "/fleet/wrk_1",
      },
    ];
    for (const { follow, heading, path } of links) {
      const { unmount, user } = renderConsole({
        mode: "worker",
        routes: { ...STATS, "/v1/workers": { body: { workers: [ONE_HOST] } } },
      });
      await screen.findByRole("heading", { level: 1, name: "Overview" });
      await waitFor(() => expect(follow()).toBeVisible());
      await user.click(follow());
      await waitFor(() => expect(window.location.pathname, path).toBe(path));
      expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeVisible();
      expect(screen.queryByRole("heading", { level: 1, name: "Page not found" })).toBeNull();
      unmount();
    }
  });

  it("the Queue page's Wait p95 equals GET /v1/stats?since=1h totals.wait.p95, also when opened as /queue?range=7d", async () => {
    renderConsole({ mode: "worker", path: "/queue?range=7d", routes: STATS });

    expect(await screen.findByRole("heading", { level: 1, name: "Queue" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("main")).toHaveTextContent("Wait p95 38 s last hour"),
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("the Overview's banner", () => {
  it("an empty Inbox draws no banner; a disconnected worker draws one naming it, with the Open Inbox button", async () => {
    let items: ReturnType<typeof workerItem>[] = [];
    const { events, user } = renderConsole({
      routes: { ...STATS, "/v1/inbox": () => ({ body: { items } }) },
    });
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.queryByText("1 thing needs you")).toBeNull();

    items = [
      workerItem(
        "disconnected",
        "Broken",
        worker({ connection: "disconnected", id: "wrk_2", label: "worker-b" }),
      ),
    ];
    events.push("worker.disconnected", event("worker.disconnected", { workerId: "wrk_2" }));

    expect(await screen.findByText("1 thing needs you")).toBeVisible();
    expect(screen.getByRole("link", { name: /worker-b · disconnected/ })).toBeVisible();
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
    await user.click(screen.getByRole("link", { name: "Open Inbox" }));
    await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
  });

  it("with five problem items the banner counts five, links the first and says four more, and the link opens /inbox/<key>", async () => {
    const items = [1, 2, 3, 4, 5].map((index) =>
      workerItem(
        "incompatible",
        "Broken",
        worker({ connection: "incompatible", id: `wrk_old_${index}`, label: `old-${index}` }),
      ),
    );
    const { user } = renderConsole({ routes: { ...STATS, "/v1/inbox": { body: { items } } } });

    expect(await screen.findByText("5 things need you")).toBeVisible();
    expect(screen.getByText(/and 4 more/)).toBeVisible();
    await user.click(screen.getByRole("link", { name: /· incompatible$/ }));
    await waitFor(() =>
      expect(window.location.pathname).toMatch(/^\/inbox\/wrk_old_\d(%2F|\/)incompatible$/),
    );
  });

  it("with /v1/inbox failing, Overview shows the daemon's refusal and no banner", async () => {
    renderConsole({
      routes: {
        ...STATS,
        "/v1/inbox": {
          body: { error: { code: "INTERNAL", message: "The inbox is down." } },
          status: 500,
        },
      },
    });

    expect(await screen.findByText("The inbox is down.")).toBeVisible();
    expect(screen.queryByText(/things? needs? you/)).toBeNull();
  });
});

describe("the Overview when the workers cannot be read", () => {
  it("with /v1/workers failing, Overview shows the daemon's refusal and no capacity", async () => {
    renderConsole({
      routes: {
        ...STATS,
        "/v1/workers": {
          body: { error: { code: "INTERNAL", message: "The fleet is down." } },
          status: 500,
        },
      },
    });

    expect(await screen.findByText("The fleet is down.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Capacity" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Fleet" })).toBeNull();
  });
});

describe("the Overview's six numbers", () => {
  it("show the daemon's values: one lease held of four devices with three ready, one request waiting with its longest wait, two of two workers, Wait p95, and Ending soon counting a lease with 4 minutes left and not one with 10, and the Queue and Ending soon rows open their pages", async () => {
    const { user } = renderConsole({
      routes: {
        ...STATS,
        "/v1/lease-requests": {
          body: {
            requests: [request({ createdAt: NOW - 125_000, id: "req_stub", requesterId: "stub" })],
          },
        },
        "/v1/leases": {
          body: {
            leases: [
              lease({ ttlDeadline: NOW + 4 * 60_000 }),
              lease({ id: "lease-later", ttlDeadline: NOW + 10 * 60_000 }),
            ],
          },
        },
        "/v1/tokens": { body: { tokens: [token()] } },
        "/v1/workers": {
          body: {
            workers: [
              worker({
                devices: [
                  device({ id: "dev_1", state: "leased" }),
                  device({ id: "dev_2", state: "ready" }),
                ],
                id: "wrk_a",
                label: "worker-a",
                leases: [lease()],
              }),
              worker({
                devices: [
                  device({ id: "dev_3", state: "ready" }),
                  device({ id: "dev_4", state: "ready" }),
                ],
                id: "wrk_b",
                label: "worker-b",
              }),
            ],
          },
        },
      },
    });

    await waitFor(() => expect(tile("Leased")).toHaveAccessibleName("Leased 1 / 4"));
    expect(tile("Ready")).toHaveAccessibleName("Ready 3 warm");
    expect(tile("Waiting")).toHaveAccessibleName("Waiting 1 max 2 min 5 s");
    expect(tile("Workers")).toHaveAccessibleName("Workers 2 / 2");
    await waitFor(() => expect(tile("Wait p95")).toHaveAccessibleName("Wait p95 38 s last hour"));
    expect(tile("Ending soon")).toHaveAccessibleName("Ending soon 1 < 5 min");

    const queue = screen.getByRole("region", { name: "Queue" });
    const waiting = within(queue).getByRole("link", { name: /stub/ });
    expect(waiting).toHaveAttribute("href", "/queue/req_stub");
    expect(waiting).toHaveTextContent("2 min 5 s");
    const ending = within(
      within(queue).getByRole("region", { name: "Ending soon" }).parentElement as HTMLElement,
    )
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.startsWith("/leases/"));
    expect(ending).toHaveTextContent("4:00");
    await user.click(waiting);
    await waitFor(() => expect(window.location.pathname).toBe("/queue/req_stub"));
  });
});

describe("the Overview's queue when /v1/lease-requests is not answered", () => {
  it.each([
    {
      answer: { body: { error: { code: "FORBIDDEN", message: "Not yours." } }, status: 403 },
      queue: "Unavailable: Not yours.",
      title: "a refusal shows the Queue and the Waiting tile unavailable, not zero",
      waiting: "Waiting —",
    },
    {
      answer: {
        body: { error: { code: "UNSUPPORTED_IN_WORKER_MODE", message: "No queue." } },
        status: 501,
      },
      queue: "Nothing is waiting.",
      title: "a 501 from a daemon with no queue of its own shows none waiting",
      waiting: "Waiting 0 none",
    },
  ])("$title", async ({ answer, queue, waiting }) => {
    renderConsole({
      routes: {
        ...STATS,
        "/v1/lease-requests": answer,
        "/v1/workers": { body: { workers: [ONE_HOST] } },
      },
    });

    await waitFor(() => expect(tile("Waiting")).toHaveAccessibleName(waiting));
    const card = screen.getByRole("region", { name: "Queue" });
    expect(card).toHaveTextContent(queue);
    for (const other of ["Unavailable:", "Nothing is waiting."].filter(
      (t) => !queue.startsWith(t),
    )) {
      expect(card).not.toHaveTextContent(other);
    }
  });
});

describe("the Overview's Fleet card", () => {
  it("draws a row for every worker in the Fleet table, with no pager, and Open fleet goes to /fleet", async () => {
    const { user } = renderConsole({
      routes: {
        ...STATS,
        "/v1/workers": {
          body: {
            workers: [
              worker({ id: "wrk_a", label: "worker-a" }),
              worker({ id: "wrk_b", label: "worker-b" }),
            ],
          },
        },
      },
    });

    const wall = await screen.findByRole("region", { name: "Fleet" });
    const table = within(within(wall).getByRole("table"));
    for (const name of ["worker-a", "worker-b"]) {
      expect(table.getByRole("link", { name }).closest("tr")).toBeVisible();
    }
    expect(screen.queryByRole("navigation", { name: /pages$/ })).toBeNull();

    await user.click(within(wall).getByRole("link", { name: "worker-a" }));
    await waitFor(() => expect(window.location.pathname).toBe("/fleet/wrk_a"));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    await user.click(await screen.findByRole("link", { name: "Open fleet" }));
    await waitFor(() => expect(window.location.pathname).toBe("/fleet"));
  });
});

describe("the range chips", () => {
  it.each([
    ["/", "the page header", STATS, ".page-head .page-actions"],
    ["/usage", "the toolbar", FULL_STATS, ".toolbar .toolbar-start"],
  ])("%s has its four range chips in %s", async (path, _where, routes, area) => {
    renderConsole({ path, routes });

    const chips = await screen.findByRole("group", { name: "Range" });

    expect(chips.closest(area)).not.toBeNull();
    expect(within(chips).getAllByRole("radio")).toHaveLength(4);
  });
});
