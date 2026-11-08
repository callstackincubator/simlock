import { screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkerView } from "../../model/workers";
import { renderConsole, type Routes } from "../../test/console";
import { device, event, lease, NOW, worker } from "../../test/fixtures";

const GIB = 1024 ** 3;
const MAC: NonNullable<WorkerView["host"]> = {
  arch: "arm64",
  os: "macOS",
  osVersion: "26.0",
  tools: [{ build: "16F6", name: "xcode", platform: "ios", version: "16.4" }],
};

function load(cpu: number, memoryUsed: number, diskUsed: number): NonNullable<WorkerView["load"]> {
  return {
    cpu: { busyPercent: cpu, cores: 8, limited: false },
    disk: { freeBytes: ((100 - diskUsed) / 100) * 500 * GIB, totalBytes: 500 * GIB },
    memory: {
      availableBytes: ((100 - memoryUsed) / 100) * 32 * GIB,
      limited: false,
      swapUsedBytes: 0,
      totalBytes: 32 * GIB,
    },
    readAt: NOW,
  };
}

function fact(label: string): HTMLElement {
  return screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

// why: a row of a table, found by the link that carries its name.
function rowOf(name: string): HTMLElement {
  return screen.getAllByRole("link", { name })[0]!.closest("tr") as HTMLElement;
}

function devicesTable(): Promise<HTMLElement> {
  return screen.findByRole("table");
}

function ofWorkers(workers: readonly WorkerView[], path: string, extra: Routes = {}) {
  return renderConsole({ path, routes: { "/v1/workers": { body: { workers } }, ...extra } });
}

function announce(view: ReturnType<typeof renderConsole>, name: string, payload = {}) {
  view.events.push(name, event(name, payload));
}

const HOST = worker({
  devices: [device({ id: "dev_1" })],
  host: MAC,
  id: "wrk_host",
  label: "mac-1",
  load: load(12, 50, 40),
  version: "0.6.0",
});

describe("the worker page", () => {
  it("opens from clicking a worker's name at /fleet/<id> with Fleet / name as the page heading, its state word beside it, its system among the host facts, and the Devices tab selected", async () => {
    const view = ofWorkers([worker({ host: MAC, id: "wrk_a b", label: "worker-a" })], "/fleet");

    await view.user.click(await screen.findByRole("link", { name: "worker-a" }));

    expect(window.location.pathname).toBe(`/fleet/${encodeURIComponent("wrk_a b")}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Fleet / worker-a" }),
    ).toBeVisible();
    expect(screen.getByText("connected")).toBeVisible();
    expect(fact("macOS")).toHaveTextContent("26.0");
    expect(screen.queryByText(/macOS 26\.0/)).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");
  });

  it("an incompatible worker says its devices cannot be read, and shows both protocol ranges", async () => {
    const view = ofWorkers(
      [
        worker({
          connection: "incompatible",
          id: "wrk_old",
          label: "old-worker",
          protocol: { gateway: { max: 77, min: 70 }, worker: { max: 1, min: 1 } },
        }),
      ],
      "/fleet",
    );
    expect(await screen.findByRole("link", { name: "old-worker" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Needs attention 1" })).toBeVisible();
    expect(rowOf("old-worker")).toHaveTextContent("incompatible");

    await view.user.click(screen.getByRole("link", { name: "old-worker" }));

    expect(await screen.findByRole("tabpanel")).toHaveTextContent(
      "No devices: the gateway cannot read this worker.",
    );
    expect(fact("Protocol")).toHaveTextContent("incompatible gateway 70–77, worker 1–1");
    expect(screen.getByText("incompatible", { selector: ".pill" })).toBeVisible();
  });

  it("on a single host Fleet shows one worker, the host, and its page works", async () => {
    const view = renderConsole({
      mode: "worker",
      path: "/fleet",
      routes: { "/v1/workers": { body: { workers: [HOST] } } },
    });

    await view.user.click(await screen.findByRole("link", { name: "mac-1" }));

    expect(window.location.pathname).toBe("/fleet/wrk_host");
    expect(await screen.findByRole("heading", { level: 1, name: "Fleet / mac-1" })).toBeVisible();
    expect(screen.getByText("connected")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");
    expect(fact("simlock")).toHaveTextContent("0.6.0");
  });

  it("an unknown worker id shows This worker is not in the fleet. and a link to Fleet, and an unknown device id shows This device is gone.", async () => {
    const view = ofWorkers([HOST], "/fleet/wrk_nope");
    expect(await screen.findByText(/This worker is not in the fleet\./)).toBeVisible();

    await view.user.click(screen.getByRole("link", { name: "Back to Fleet" }));
    expect(window.location.pathname).toBe("/fleet");
    expect(await screen.findByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();

    view.unmount();
    ofWorkers([HOST], "/fleet/wrk_host/dev_nope?tab=devices");
    expect(
      within(await screen.findByRole("dialog")).getByText("This device is gone."),
    ).toBeVisible();
  });

  it.each([
    {
      absent: /^Drained$/,
      shown: "Disconnected · last seen 42 s ago",
      title: "a disconnected worker's page shows the banner Disconnected · last seen … ago",
      w: worker({ connection: "disconnected", id: "wrk_c", label: "w", lastSeenAt: NOW - 42_000 }),
    },
    {
      absent: /^Disconnected/,
      shown: "Drained",
      title: "a drained worker's page shows the banner Drained",
      w: worker({ drained: true, id: "wrk_c", label: "w" }),
    },
    {
      absent: /^Drained$|^Disconnected/,
      shown: undefined,
      title: "a connected worker's page shows neither banner",
      w: worker({ id: "wrk_c", label: "w" }),
    },
  ])("$title", async ({ absent, shown, w }) => {
    ofWorkers([w], "/fleet/wrk_c");
    expect(await screen.findByRole("heading", { level: 1, name: "Fleet / w" })).toBeVisible();

    if (shown !== undefined) expect(screen.getByText(shown, { selector: "p" })).toBeVisible();
    expect(screen.queryByText(absent, { selector: "p" })).not.toBeInTheDocument();
  });

  it("a worker's devices are rows of a table, each with its state, and for a leased one its holder as text, time left and when it was granted", async () => {
    const held = lease({ deviceId: "dev_leased", id: "lse_1", requesterId: "console-e2e-3" });
    ofWorkers(
      [
        worker({
          devices: [
            device({ id: "dev_idle", state: "ready" }),
            device({ id: "dev_leased", state: "leased" }),
          ],
          id: "wrk_host",
          label: "mac-1",
          leases: [held],
        }),
      ],
      "/fleet/wrk_host",
    );

    const tiles = within(await devicesTable())
      .getAllByRole("row")
      .slice(1)
      .filter((row) => within(row).queryByRole("link", { name: "iPhone 16" }) !== null);
    expect(tiles).toHaveLength(2);
    const [idle, leased] = tiles.map((tile) => within(tile));
    for (const [tile, state] of [
      [idle, "ready"],
      [leased, "leased"],
    ] as const) {
      expect(tile!.getByText(state, { selector: ".pill" })).toBeVisible();
      expect(tile!.getByText("iPhone 16")).toBeVisible();
      expect(tile!.getByText("iOS 18.4")).toBeVisible();
    }
    expect(idle!.queryByText("console-e2e-3")).not.toBeInTheDocument();
    expect(idle!.queryByTitle(/^expires in/)).not.toBeInTheDocument();
    expect(leased!.getByText("console-e2e-3")).toBeVisible();
    expect(leased!.queryByRole("link", { name: "console-e2e-3" })).not.toBeInTheDocument();
    expect(leased!.getByText("10:00")).toBeVisible();
    expect(tiles[1]).toHaveTextContent(/granted \d\d:\d\d/);
    expect(leased!.getByRole("link", { name: "Watch" })).toHaveAttribute(
      "href",
      "/fleet/wrk_host/devices/dev_leased/",
    );
  });

  it("a Devices row opens the drawer at /fleet/<id>/<deviceId> with the device's model, runtime, state word, and holder and lease when leased; a leased device shows its UDID and an unleased simulator shows no UDID field", async () => {
    const held = lease({ deviceId: "dev_leased", id: "lse_1", requesterId: "console-e2e-3" });
    const view = ofWorkers(
      [
        worker({
          devices: [
            device({ id: "dev_idle", state: "ready" }),
            device({
              id: "dev_leased",
              spec: { model: "iPhone 17", osVersion: "26.0", physical: false, platform: "ios" },
              state: "leased",
            }),
          ],
          id: "wrk_host",
          label: "mac-1",
          leases: [held],
        }),
      ],
      "/fleet/wrk_host",
      {
        "/v1/leases/lse_1": {
          body: {
            lease: {
              createdAt: new Date(NOW - 3_600_000).toISOString(),
              device: "iPhone 17",
              deviceId: "dev_leased",
              expiresAt: new Date(NOW + 600_000).toISOString(),
              id: "lse_1",
              udid: "UDID-LEASED-1",
            },
          },
        },
      },
    );
    const tile = async (model: string) =>
      within(await devicesTable())
        .getAllByRole("link", { name: model })
        .at(0)!;

    await view.user.click(await tile("iPhone 16"));
    const drawer = await screen.findByRole("dialog");
    expect(window.location.pathname + window.location.search).toBe(
      "/fleet/wrk_host/dev_idle?tab=devices",
    );
    expect(fact("Model")).toHaveTextContent("iPhone 16");
    expect(fact("Runtime")).toHaveTextContent("18.4");
    expect(fact("State")).toHaveTextContent("ready");
    expect(within(drawer).queryByText("Holder")).not.toBeInTheDocument();
    expect(within(drawer).queryByText("UDID")).not.toBeInTheDocument();
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await view.user.click(await tile("iPhone 17"));
    await screen.findByRole("dialog");
    expect(fact("Model")).toHaveTextContent("iPhone 17");
    expect(fact("State")).toHaveTextContent("leased");
    expect(fact("Holder")).toHaveTextContent("console-e2e-3");
    expect(within(fact("Lease")).getByRole("link")).toHaveAttribute("href", "/leases/lse_1/");
    expect(await screen.findByText("UDID-LEASED-1")).toBeVisible();
    expect(fact("UDID")).toHaveTextContent("UDID-LEASED-1");
  });

  it("closing the device drawer returns to /fleet/<id>?tab=devices with focus on the row", async () => {
    const view = ofWorkers(
      [worker({ devices: [device({ id: "dev_1" })], id: "wrk_host", label: "mac-1" })],
      "/fleet/wrk_host",
    );
    const row = async () =>
      within(await devicesTable()).getByRole("link", {
        name: "iPhone 16",
      });
    const closers = [
      () => view.user.click(screen.getByRole("button", { name: "Close" })),
      () => view.user.keyboard("{Escape}"),
    ];

    for (const close of closers) {
      await view.user.click(await row());
      await screen.findByRole("dialog");
      await close();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(window.location.pathname + window.location.search).toBe("/fleet/wrk_host?tab=devices");
      await waitFor(async () => expect(await row()).toHaveFocus());
    }
  });

  describe("the Events tab", () => {
    // why: happy-dom lays nothing out, so the virtual list sees a box of zero height and draws no
    // row; the box is given the height the feed itself assumes before it is measured.
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    beforeAll(() => {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get: () => 640,
      });
    });
    afterAll(() => {
      if (clientHeight !== undefined) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      }
    });

    it("on a gateway the Events tab lists only that worker's events and shows its new events at the top", async () => {
      const granted = event("lease.granted", { requesterId: "console-e2e", workerId: "wrk_a" });
      const drain = event("worker.drain-started", { workerId: "wrk_b" });
      const view = ofWorkers(
        [worker({ id: "wrk_a", label: "worker-a" }), worker({ id: "wrk_b", label: "worker-b" })],
        "/fleet/wrk_a?tab=events",
        {
          "/v1/events": (call) => {
            const asked = new URLSearchParams(call.search).get("worker");
            const mine = [granted, drain].filter(
              (held) => (held.payload as { workerId: string }).workerId === asked,
            );
            return { body: { events: call.search.includes("before=") ? [] : mine } };
          },
        },
      );
      const feed = async () =>
        within(await screen.findByRole("list", { name: "Events for this worker" }));

      expect((await feed()).getByText("lease.granted")).toBeVisible();
      expect((await feed()).queryByText("worker.drain-started")).not.toBeInTheDocument();
      const newest = (await feed()).getAllByRole("listitem")[0]!.textContent;

      view.events.push(
        "lease.granted",
        event("lease.granted", { requesterId: "console-e2e-other", workerId: "wrk_b" }),
      );
      view.events.push(
        "lease.granted",
        event("lease.granted", { requesterId: "console-e2e-new", workerId: "wrk_a" }),
      );
      await waitFor(async () =>
        expect((await feed()).getAllByRole("listitem")[0]!.textContent).not.toBe(newest),
      );
      expect((await feed()).getAllByRole("listitem")[0]).toHaveTextContent("console-e2e-new");
      expect((await feed()).queryByText("console-e2e-other")).not.toBeInTheDocument();
      expect(view.callsTo("GET", "/v1/events").length).toBeGreaterThan(0);
      for (const call of view.callsTo("GET", "/v1/events"))
        expect(call.search).toContain("worker=wrk_a");

      view.unmount();
      renderConsole({
        path: "/fleet/wrk_b?tab=events",
        routes: {
          "/v1/events": (call) => ({
            body: {
              events: call.search.includes("before=")
                ? []
                : [granted, drain].filter(
                    (held) =>
                      (held.payload as { workerId: string }).workerId ===
                      new URLSearchParams(call.search).get("worker"),
                  ),
            },
          }),
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
      const forB = within(await screen.findByRole("list", { name: "Events for this worker" }));
      expect(forB.getByText("worker.drain-started")).toBeVisible();
      expect(forB.queryByText("lease.granted")).not.toBeInTheDocument();
    });

    it("with no events the Events tab says No events for this worker yet.", async () => {
      ofWorkers([HOST], "/fleet/wrk_host?tab=events", { "/v1/events": { body: { events: [] } } });

      expect(await screen.findByText("No events for this worker yet.")).toBeVisible();
    });

    it("on a single host the Events tab lists all the events, which name no worker", async () => {
      renderConsole({
        mode: "worker",
        path: "/fleet/wrk_host?tab=events",
        routes: {
          "/v1/events": {
            body: { events: [event("lease.granted", { requesterId: "console-e2e-host" })] },
          },
          "/v1/workers": { body: { workers: [HOST] } },
        },
      });

      const feed = within(await screen.findByRole("list", { name: "Events for this worker" }));
      expect(feed.getByText("lease.granted")).toBeVisible();
      expect(feed.getByText("console-e2e-host")).toBeVisible();
    });
  });

  it("shows its host facts and the two tabs, sets ?tab=, survives a reload, and lands ?tab=host on Devices", async () => {
    const host = worker({
      ...HOST,
      installs: [
        {
          component: "19.0",
          platform: "ios",
          since: NOW - 30_000,
          state: "downloading",
          waiters: 1,
        },
      ],
    });
    const view = ofWorkers([host], "/fleet");
    await view.user.click(await screen.findByRole("link", { name: "mac-1" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Fleet / mac-1" })).toBeVisible();
    expect(fact("macOS")).toHaveTextContent("26.0");
    expect(fact("xcode")).toHaveTextContent("16.4 (16F6)");
    expect(fact("Worker id")).toHaveTextContent("wrk_host");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Devices",
      "Warm pool",
    ]);

    await view.user.click(screen.getByRole("tab", { name: "Warm pool" }));
    expect(window.location.search).toBe("?tab=warm-pool");
    expect(screen.getByRole("region", { name: "Installs in progress" })).toHaveTextContent(
      /iOS 19\.0\s*downloading for \d+ s, 1 waiter/,
    );
    expect(screen.getByRole("region", { name: "Events on this worker" })).toBeVisible();

    await view.user.click(screen.getByRole("tab", { name: "Devices" }));
    expect(window.location.search).toBe("?tab=devices");
    expect(screen.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");

    let current = view;
    for (const tab of ["Warm pool", "Devices"]) {
      await current.user.click(screen.getByRole("tab", { name: tab }));
      current.unmount();
      current = ofWorkers([host], window.location.pathname + window.location.search);
      expect(await screen.findByRole("tab", { name: tab })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
    for (const asked of ["host", "events"]) {
      current.unmount();
      current = ofWorkers([host], `/fleet/wrk_host?tab=${asked}`);
      expect(await screen.findByRole("tab", { name: "Devices" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(fact("Worker id")).toHaveTextContent("wrk_host");
    }
  });

  it("a granted lease eventually appears on the worker's page and its Fleet row without a reload", async () => {
    let leased = false;
    const view = renderConsole({
      path: "/fleet",
      routes: {
        "/v1/workers": () => ({
          body: {
            workers: [
              worker({
                devices: [device({ id: "dev_1", state: leased ? "leased" : "ready" })],
                id: "wrk_a",
                label: "worker-a",
                leases: leased ? [lease({ deviceId: "dev_1" })] : [],
              }),
            ],
          },
        }),
      },
    });
    await screen.findByRole("link", { name: "worker-a" });
    expect(within(rowOf("worker-a")).getByRole("cell", { name: "0" })).toBeVisible();
    await view.user.click(screen.getByRole("link", { name: "worker-a" }));
    const slots = within(await screen.findByRole("group", { name: "Load and leases" }));
    expect(slots.getByText("0 of 6 leased")).toBeVisible();

    leased = true;
    announce(view, "lease.granted", { workerId: "wrk_a" });

    expect(await slots.findByText("1 of 6 leased")).toBeVisible();
    window.history.back();
    await waitFor(() =>
      expect(within(rowOf("worker-a")).getByRole("cell", { name: "1" })).toBeVisible(),
    );
  });

  it("starting the daemon again refreshes the data the page shows", async () => {
    let xcode = "16.4";
    let away = false;
    const view = renderConsole({
      path: "/fleet/wrk_host",
      routes: {
        "/v1/healthz": () => {
          if (away) throw new TypeError("Failed to fetch");
          return { body: {} };
        },
        "/v1/workers": () => ({
          body: {
            workers: [
              worker({
                ...HOST,
                host: { ...MAC, tools: [{ name: "xcode", platform: "ios", version: xcode }] },
              }),
            ],
          },
        }),
      },
    });
    await screen.findByText("Connected");
    expect(await screen.findByText("xcode", { selector: "dt" })).toBeVisible();
    expect(fact("xcode")).toHaveTextContent("16.4");

    away = true;
    view.events.drop();
    expect(await screen.findByText(/^Reconnecting/)).toBeVisible();
    expect(fact("xcode")).toHaveTextContent("16.4");

    xcode = "26.0";
    away = false;
    expect(await screen.findByText("Connected", {}, { timeout: 5_000 })).toBeVisible();
    await waitFor(() => expect(fact("xcode")).toHaveTextContent("26.0"));
  });

  it("shows four ring gauges and no note of the reading's age under the title", async () => {
    ofWorkers(
      [worker({ ...HOST, load: { ...load(12, 50, 40), readAt: NOW - 3_000 } })],
      "/fleet/wrk_host",
    );

    const group = within(await screen.findByRole("group", { name: "Load and leases" }));
    expect(group.getByText(/12% busy/)).toBeVisible();
    expect(group.getByText(/used/)).toBeVisible();
    expect(group.getByText(/GiB free/)).toBeVisible();
    expect(group.getByText(/leased/)).toBeVisible();
    expect(group.getAllByText(/^(\d+%|—)$/)).toHaveLength(4);
    expect(
      within(
        screen.getByRole("complementary", { name: "Slots, host, capabilities and baselines" }),
      ).getAllByRole("img")[0],
    ).toBeVisible();
    expect(screen.queryByText(/read \d+ s ago/)).not.toBeInTheDocument();
  });

  it.each([
    { limit: 10, squares: 10, shown: "2 / 10", meter: 0 },
    { limit: 20, squares: 0, shown: "2 / 20", meter: 1 },
  ])(
    "its side card draws $limit slots as $squares squares and $meter meter, with $shown beside them",
    async ({ limit, meter, shown, squares }) => {
      const base = worker().capacity!;
      ofWorkers(
        [
          worker({
            capacity: {
              android: base.android,
              global: { ...base.global, maxRunning: limit },
              ios: { ...base.ios, limit, maxRunning: limit },
            },
            devices: ["leased", "leased", "absent", "quarantined"].map((state, index) =>
              device({ id: `dev_${index}`, state: state as "leased" }),
            ),
            id: "wrk_s",
            label: "slots-a",
          }),
        ],
        "/fleet/wrk_s",
      );
      const side = within(
        await screen.findByRole("complementary", {
          name: "Slots, host, capabilities and baselines",
        }),
      );
      const slots = side.getByRole("img", { name: /2 leased, 1 absent, 1 quarantined/ });
      expect(slots).toHaveTextContent(shown);
      expect(within(slots).queryAllByTitle(/./)).toHaveLength(squares);
      if (squares > 0) {
        expect(within(slots).getAllByTitle("iPhone 16 18.4, absent")).toHaveLength(1);
        expect(within(slots).getAllByTitle("iPhone 16 18.4, quarantined")).toHaveLength(1);
      }
      expect(slots.querySelectorAll("[style*='--load-bar']")).toHaveLength(meter);
    },
  );

  it("fills each ring to its figure's own percent", async () => {
    ofWorkers([worker({ ...HOST, load: load(36.6, 61.4, 85) })], "/fleet/wrk_host");
    const group = await screen.findByRole("group", { name: "Load and leases" });

    for (const [label, percent] of [
      ["CPU", 37],
      ["Memory", 61],
      ["Disk", 85],
    ] as const) {
      const gauge = [...group.children].find((child) => child.textContent?.includes(label))!;
      expect(within(gauge as HTMLElement).getByText(`${percent}%`)).toBeVisible();
      const [dash = "0", whole = "1"] = (
        gauge.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray") ?? ""
      ).split(" ");
      expect(Number(dash) / Number(whole)).toBeCloseTo(percent / 100, 2);
    }
  });

  it("a disconnected worker's state word and load say so", async () => {
    let connection: WorkerView["connection"] = "connected";
    const fleet = () => [
      worker({ ...HOST, connection, id: "wrk_b", label: "worker-b" }),
      worker({ id: "wrk_a", label: "worker-a" }),
    ];
    const view = renderConsole({
      path: "/fleet",
      routes: { "/v1/workers": () => ({ body: { workers: fleet() } }) },
    });
    await view.user.click(await screen.findByRole("link", { name: "worker-b" }));
    expect(
      within(await screen.findByRole("group", { name: "Load and leases" })).getByText(/12% busy/),
    ).toBeVisible();

    connection = "disconnected";
    announce(view, "worker.disconnected", { workerId: "wrk_b" });

    expect(await screen.findByText("No reading while disconnected")).toBeVisible();
    expect(screen.getByText("disconnected", { selector: ".pill" })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(rowOf("worker-b")).toHaveTextContent("disconnected"));
    expect(rowOf("worker-a")).not.toHaveTextContent("disconnected");
  });
});

describe("a worker page's actions", () => {
  it("a worker page's button is its first safe action", async () => {
    let updateAvailable = true;
    let drained = false;
    let connection: WorkerView["connection"] = "connected";
    const view = renderConsole({
      daemon: { latestVersion: "0.4.0", version: "0.3.0" },
      path: "/fleet/wrk_bar",
      routes: {
        "/v1/workers": () => ({
          body: {
            workers: [
              worker({
                connection,
                drained,
                id: "wrk_bar",
                label: "bar-a",
                ...(updateAvailable
                  ? {
                      lastUpdateFailure: null,
                      latestVersion: "0.4.0",
                      update: null,
                      version: "0.3.0",
                    }
                  : {}),
              }),
            ],
          },
        }),
        "POST /v1/workers/*/drain": () => {
          drained = true;
          return { body: {} };
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Fleet / bar-a" });
    expect(await screen.findByRole("button", { name: "Drain" })).toBeVisible();
    await view.user.click(screen.getByRole("button", { name: "Actions for bar-a" }));
    expect(screen.getByRole("menuitem", { name: "Update…" })).toBeVisible();
    await view.user.keyboard("{Escape}");

    updateAvailable = false;
    await view.user.click(screen.getByRole("button", { name: "Drain" }));
    expect(await screen.findByText("bar-a drained")).toBeVisible();
    announce(view, "worker.drain-started", { workerId: "wrk_bar" });
    expect(await screen.findByRole("button", { name: "Undrain" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Actions for bar-a" })).not.toBeInTheDocument();

    connection = "disconnected";
    announce(view, "worker.disconnected", { workerId: "wrk_bar" });
    await view.user.click(await screen.findByRole("button", { name: "Actions for bar-a" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Remove worker",
    ]);
    await view.user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Undrain" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove worker" })).not.toBeInTheDocument();
  });
});
