import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleEvent } from "../../model/events";
import { type Handler, renderConsole, type Routes } from "../../test/console";
import { event, lease, NOW, worker } from "../../test/fixtures";

// why: the feed draws only the rows its box has room for, and happy-dom lays nothing out, so the
// box is given the height the feed assumes before it is measured, and a row is the fixed height
// the screen draws.
const BOX_PX = 640;
const ROW_PX = 38;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("aria-label") === "Event feed" ? BOX_PX : 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubbed(n: number): ConsoleEvent {
  return event(
    "lease.renewed",
    {},
    { id: `evt_${String(n).padStart(4, "0")}`, seq: 1_000_000 - n, timestamp: NOW - n * 60_000 },
  );
}

function stubbedRange(from: number, to: number): ConsoleEvent[] {
  return Array.from({ length: to - from + 1 }, (_, index) => stubbed(to - index));
}

function at(id: string, name: string, minutes: number, payload: unknown = {}): ConsoleEvent {
  return event(name, payload, { id, seq: 1_000_000 - minutes, timestamp: NOW - minutes * 60_000 });
}

function localMinute(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

interface Answer {
  readonly status?: number;
  readonly events?: readonly ConsoleEvent[];
}

// why: answers every `GET /v1/events` with what `answer` returns for its query; the calls the test
// reads back are the pages the console asked for.
function eventsRoute(answer: (query: URLSearchParams) => Answer | Promise<Answer>): Routes {
  const handler: Handler = async (call) => {
    const { events = [], status = 200 } = await answer(new URLSearchParams(call.search));
    return status === 200
      ? { body: { events } }
      : { body: { error: { code: "STUBBED", message: "stubbed" } }, status };
  };
  return { "/v1/events": handler };
}

function older(calls: readonly { readonly search: string }[]): string[] {
  return calls.map((call) => call.search).filter((search) => !search.startsWith("?since="));
}

function feed(): HTMLElement {
  return screen.getByRole("region", { name: "Event feed" });
}

function rows(): HTMLElement[] {
  return within(feed()).queryAllByRole("listitem");
}

function names(): string[] {
  return rows().map((row) => within(row).getByRole("link").textContent ?? "");
}

function hrefs(): string[] {
  return rows().map((row) => within(row).getByRole("link").getAttribute("href") ?? "");
}

// why: the feed prints no count and draws only the rows in view, so the rows held are the ones
// drawn plus the space of the rest, one row tall per event.
function eventsHeld(): number {
  const list = screen.getByRole("list", { name: "Events" });
  const space = (side: "paddingBottom" | "paddingTop") => Number.parseInt(list.style[side]) || 0;
  return list.children.length + (space("paddingTop") + space("paddingBottom")) / ROW_PX;
}

function kind(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Kind" })).getByRole("checkbox", {
    name: new RegExp(`^${name}`),
  });
}

function title(): HTMLElement {
  return screen.getAllByRole("heading", { level: 2 })[0] as HTMLElement;
}

describe("the Activity page", () => {
  it("shows a lease granted while it is open in the feed, and opens its page from it", async () => {
    const { events, user } = renderConsole({
      path: "/activity",
      routes: {
        ...eventsRoute(() => ({ events: [at("evt_started", "daemon.started", 10)] })),
        "/v1/leases": { body: { leases: [lease({ id: "lse_1" })] } },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(names().some((name) => name.startsWith("lease.granted"))).toBe(false);

    const granted = at("evt_granted", "lease.granted", 0, { deviceId: "dev_1", leaseId: "lse_1" });
    events.push("lease.granted", granted);

    await waitFor(() => expect(rows()).toHaveLength(2));
    const row = rows().find((candidate) => candidate.textContent?.includes("lease.granted"));
    await user.click(within(row as HTMLElement).getByRole("link"));
    expect(title()).toHaveTextContent("lease.granted");
    expect(window.location.pathname).toMatch(/\/activity\/[^/]+$/);
    expect(screen.getByText("leaseId")).toBeVisible();
    expect(screen.getByText("lse_1", { selector: "dd" })).toBeVisible();

    await user.click(screen.getByRole("link", { name: "Open lease" }));
    expect(window.location.pathname).toMatch(/^\/leases\/lse_1\/?$/);
  });

  it("shows the events the daemon answers, newest first, and after a restart the feed has no gap and no duplicate", async () => {
    const started = at("evt_a", "daemon.started", 10);
    const before = at("evt_b", "lease.granted", 5);
    let answered = [started, before];
    const { events } = renderConsole({
      path: "/activity",
      routes: {
        ...eventsRoute(() => ({ events: answered })),
        "/v1/healthz": { body: { ok: true } },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(hrefs()).toEqual(["/activity/evt_b", "/activity/evt_a"]);
    expect(names()[0]).toMatch(/^lease\.granted/);
    expect(names()[1]).toMatch(/^daemon\.started/);

    // why: the daemon is gone for a moment: an event happens while it is, and another once it is back.
    const gap = at("evt_c", "lease.released", 3);
    const after = at("evt_d", "lease.granted", 1);
    events.drop();
    expect(await screen.findByText(/^Reconnecting/)).toBeVisible();
    answered = [started, before, gap, after];
    expect(await screen.findByText("Connected", {}, { timeout: 5_000 })).toBeVisible();
    events.push("lease.granted", after);

    await waitFor(() =>
      expect(hrefs()).toEqual(answered.toReversed().map((e) => `/activity/${e.id}`)),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hrefs()).toHaveLength(4);
  });

  it("puts the chosen event in the URL and its payload whole in the drawer, and keeps it on a reload", async () => {
    const started = at("evt_started", "daemon.started", 10, { pid: 42, version: "0.6.0" });
    const routes = eventsRoute(() => ({ events: [started, at("evt_x", "lease.granted", 2)] }));
    const first = renderConsole({ path: "/activity", routes });
    await waitFor(() => expect(rows()).toHaveLength(2));

    await first.user.click(
      within(
        rows().find((row) => row.textContent?.includes("daemon.started")) as HTMLElement,
      ).getByRole("link"),
    );

    expect(window.location.pathname).toBe("/activity/evt_started");
    expect(title()).toHaveTextContent("daemon.started");
    expect(screen.getByRole("heading", { level: 3, name: "Payload" })).toBeVisible();
    expect(screen.getByText("pid")).toBeVisible();
    expect(screen.getByText("42", { selector: "dd" })).toBeVisible();
    first.unmount();
    renderConsole({ path: window.location.pathname, routes });

    await waitFor(() => expect(title()).toHaveTextContent("daemon.started"));
  });

  it("opens the drawer for an address of an event not among those loaded, and says older events load as the list scrolls", async () => {
    renderConsole({ path: "/activity/evt_not_there" });

    expect(
      within(await screen.findByRole("dialog")).getByText(
        "This event is not among those loaded. Older events load as you scroll the list, or with Load older events.",
      ),
    ).toBeVisible();
  });

  it("replaces the address with /activity and focuses the heading when the drawer, loaded directly at an event's address, closes", async () => {
    const { user } = renderConsole({ path: "/activity/evt_not_there" });
    const drawer = await screen.findByRole("dialog");
    const entries = window.history.length;

    await user.keyboard("{Escape}");

    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/activity");
    expect(window.history.length).toBe(entries);
    expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toHaveFocus();
  });

  it("shows only the events the filter and the search match, and keeps both in the URL", async () => {
    const routes = eventsRoute(() => ({
      events: [
        at("evt_1", "lease.granted", 1),
        at("evt_2", "device.ready", 2),
        at("evt_3", "lease.released", 3),
        at("evt_4", "lease.granted", 4),
        at("evt_5", "daemon.started", 5),
      ],
    }));
    const first = renderConsole({ path: "/activity", routes });
    await waitFor(() => expect(rows()).toHaveLength(5));

    await first.user.click(kind("Leases"));

    await waitFor(() => expect(window.location.search).toBe("?kind=lease"));
    expect(rows()).toHaveLength(3);
    expect(names().every((name) => name.startsWith("lease."))).toBe(true);
    first.unmount();
    const second = renderConsole({ path: "/activity?kind=lease", routes });
    await waitFor(() => expect(kind("Leases")).toBeChecked());

    await second.user.type(screen.getByRole("searchbox", { name: "Search events" }), "GRANTED");

    await waitFor(() => expect(window.location.search).toBe("?kind=lease&q=GRANTED"));
    expect(rows()).toHaveLength(2);
    expect(names().every((name) => name.startsWith("lease.granted"))).toBe(true);
    second.unmount();
    renderConsole({ path: "/activity?kind=lease&q=GRANTED", routes });
    await waitFor(() =>
      expect(screen.getByRole("searchbox", { name: "Search events" })).toHaveValue("GRANTED"),
    );
  });

  it("counts the events by kind, state and worker, and Problems only, workers and the range narrow the feed", async () => {
    const { user } = renderConsole({
      path: "/activity",
      routes: eventsRoute(() => ({
        events: [
          at("evt_f1", "lease.granted", 1, { workerId: "wrk_a" }),
          at("evt_f2", "queue.changed", 2),
          at("evt_f3", "device.quarantined", 3, { workerId: "wrk_a" }),
          at("evt_f4", "baseline.built", 4, { workerId: "wrk_b" }),
          at("evt_f5", "lease.renewed", 180, { workerId: "wrk_b" }),
        ],
      })),
    });
    const group = (name: string) => within(screen.getByRole("group", { name }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(group("Kind").getByRole("checkbox", { name: /^Leases/ })).toHaveAccessibleName(
      /Leases\s*1/,
    );
    expect(group("Kind").getByRole("checkbox", { name: /^Queue/ })).toHaveAccessibleName(
      /Queue\s*1/,
    );
    expect(group("State").getByRole("checkbox", { name: /^Problems only/ })).toHaveAccessibleName(
      /Problems only\s*1/,
    );
    expect(group("Worker").getByRole("checkbox", { name: /^Other/ })).toHaveAccessibleName(
      /Other\s*1/,
    );

    await user.click(group("State").getByRole("checkbox"));
    await waitFor(() => expect(window.location.search).toBe("?state=problems"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("device.quarantined");
    expect(group("Kind").getByRole("checkbox", { name: /^Leases/ })).toHaveAccessibleName(
      /Leases\s*0/,
    );

    await user.click(group("State").getByRole("checkbox"));
    await user.click(group("Worker").getByRole("checkbox", { name: /^Other/ }));
    await waitFor(() => expect(window.location.search).toBe("?worker="));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("queue.changed");

    await user.click(screen.getByRole("radio", { name: "6 h" }));
    await waitFor(() => expect(window.location.search).toBe("?worker=&range=6h"));
    await user.click(group("Worker").getByRole("checkbox", { name: /^Other/ }));
    await waitFor(() => expect(rows()).toHaveLength(5));
  });

  it("loads the 100 events before the oldest held when the list opens near its end, and holds them once", async () => {
    const { callsTo } = renderConsole({
      path: "/activity?range=24h",
      routes: eventsRoute((query) => {
        const before = query.get("before");
        if (before === null) return { events: stubbedRange(1, 30) };
        return before === "evt_0030" ? { events: stubbedRange(31, 130) } : {};
      }),
    });

    await waitFor(() => expect(eventsHeld()).toBe(130));
    expect(older(callsTo("GET", "/v1/events"))).toEqual(["?before=evt_0030&limit=100"]);
  });

  describe("the end row", () => {
    it("says where the history starts once the older events are all held", async () => {
      const { callsTo } = renderConsole({
        path: "/activity?range=24h",
        routes: eventsRoute((query) => {
          if (query.get("before") === null) return { events: stubbedRange(1, 30) };
          return query.get("before") === "evt_0030" ? { events: stubbedRange(31, 70) } : {};
        }),
      });

      expect(
        await screen.findByText(`Start of the history (${localMinute(NOW - 70 * 60_000)})`),
      ).toBeVisible();
      await waitFor(() => expect(eventsHeld()).toBe(70));
      expect(older(callsTo("GET", "/v1/events"))).toEqual(["?before=evt_0030&limit=100"]);
    });

    it("says the newest 10,000 events are shown at the cap", async () => {
      renderConsole({
        path: "/activity?range=24h",
        routes: eventsRoute(() => ({ events: stubbedRange(1, 10_000) })),
      });

      expect(await screen.findByText("Showing the newest 10,000 events.")).toBeVisible();
    });

    it("says older events are no longer kept after a 422", async () => {
      const { callsTo } = renderConsole({
        path: "/activity?range=24h",
        routes: eventsRoute((query) =>
          query.get("before") === null ? { events: stubbedRange(1, 30) } : { status: 422 },
        ),
      });

      expect(await screen.findByText("Older events are no longer kept.")).toBeVisible();
      expect(older(callsTo("GET", "/v1/events"))).toHaveLength(1);
    });

    it.each([503, 500])(
      "says older events are not available right now after a %i, and Try again asks once more",
      async (status) => {
        let failing = true;
        const { callsTo, user } = renderConsole({
          path: "/activity?range=24h",
          routes: eventsRoute((query) => {
            if (query.get("before") === null) return { events: stubbedRange(1, 30) };
            return failing ? { status } : { events: stubbedRange(31, 40) };
          }),
        });
        expect(await screen.findByText("Older events are not available right now.")).toBeVisible();
        expect(older(callsTo("GET", "/v1/events"))).toHaveLength(1);

        failing = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText(/^Start of the history \(/)).toBeVisible();
        expect(older(callsTo("GET", "/v1/events"))).toHaveLength(2);
      },
    );
  });

  it("shows older history at once when the last hour is quiet, and says No events yet. for an empty history", async () => {
    const quiet = renderConsole({
      path: "/activity",
      routes: eventsRoute((query) => (query.has("since") ? {} : { events: stubbedRange(1, 40) })),
    });

    await waitFor(() => expect(eventsHeld()).toBe(40));
    expect(rows().length).toBeGreaterThan(0);
    expect(older(quiet.callsTo("GET", "/v1/events"))).toEqual(["?limit=100"]);
    quiet.unmount();

    const empty = renderConsole({ path: "/activity", routes: eventsRoute(() => ({})) });

    expect(await screen.findByText("No events yet.")).toBeVisible();
    expect(older(empty.callsTo("GET", "/v1/events"))).toEqual(["?limit=100"]);
  });

  it.each(["/activity?subject=lease&range=24h", "/activity?q=RENEWED&range=24h"])(
    "loads nothing by itself with a chip or a search on at %s, and Load older events loads one page per press",
    async (address) => {
      const { callsTo, user } = renderConsole({
        path: address,
        routes: eventsRoute((query) => {
          if (query.get("before") === null) return { events: stubbedRange(1, 30) };
          if (query.get("before") === "evt_0030") return { events: stubbedRange(31, 130) };
          return query.get("before") === "evt_0130" ? { events: stubbedRange(131, 230) } : {};
        }),
      });
      await waitFor(() => expect(eventsHeld()).toBe(30));
      expect(screen.getByRole("button", { name: "Load older events" })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(older(callsTo("GET", "/v1/events"))).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Load older events" }));
      await waitFor(() => expect(eventsHeld()).toBe(130));
      expect(older(callsTo("GET", "/v1/events"))).toEqual(["?before=evt_0030&limit=100"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(older(callsTo("GET", "/v1/events"))).toHaveLength(1);

      await user.click(screen.getByRole("button", { name: "Load older events" }));
      await waitFor(() => expect(eventsHeld()).toBe(230));
      expect(older(callsTo("GET", "/v1/events"))).toHaveLength(2);
    },
  );

  it.each([
    ["/activity?kind=worker", "No events match these filters among those loaded."],
    ["/activity?q=zzz", "No events match zzz among those loaded."],
  ])(
    "says %s matches no held event and offers Load older events, which loads one page",
    async (address, said) => {
      const { callsTo, user } = renderConsole({
        path: address,
        routes: eventsRoute((query) =>
          query.get("before") === null
            ? { events: stubbedRange(1, 30) }
            : { events: stubbedRange(31, 70) },
        ),
      });
      expect(await screen.findByText(said)).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Load older events" }));

      expect(await screen.findByText(/^Start of the history \(/)).toBeVisible();
      expect(older(callsTo("GET", "/v1/events"))).toEqual(["?before=evt_0030&limit=100"]);
      expect(screen.getByText(said)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
    },
  );

  it("shows a worker's label on its event on a gateway", async () => {
    const { user } = renderConsole({
      path: "/activity",
      routes: {
        ...eventsRoute(() => ({
          events: [at("evt_g", "lease.granted", 1, { leaseId: "lse_1", workerId: "wrk_a" })],
        })),
        "/v1/workers": { body: { workers: [worker({ id: "wrk_a", label: "worker-a" })] } },
      },
    });

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("lease.granted");
    expect(rows()[0]).toHaveTextContent("worker-a");
    await user.click(within(rows()[0] as HTMLElement).getByRole("link"));
    expect(screen.getByText("workerId")).toBeVisible();
  });
});
