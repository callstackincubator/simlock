import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { WorkerView } from "../../model/workers";
import { type Answer, renderConsole, type Routes } from "../../test/console";
import { device, event, lease, NOW, worker, workerItem } from "../../test/fixtures";

const MAC = { arch: "arm64", os: "macOS", osVersion: "26.0", tools: [] };
const GIB = 1024 ** 3;

function load(cpu: number, memory: number, disk: number): NonNullable<WorkerView["load"]> {
  return {
    cpu: { busyPercent: cpu, cores: 8, limited: false },
    disk: { freeBytes: ((100 - disk) / 100) * 500 * GIB, totalBytes: 500 * GIB },
    memory: {
      availableBytes: ((100 - memory) / 100) * 32 * GIB,
      limited: false,
      swapUsedBytes: 0,
      totalBytes: 32 * GIB,
    },
    readAt: NOW,
  };
}

function cardOf(name: string): HTMLElement {
  return screen.getByRole("link", { name }).closest("article") as HTMLElement;
}

function ofWorkers(workers: readonly WorkerView[], path = "/fleet") {
  return renderConsole({ path, routes: { "/v1/workers": { body: { workers } } } });
}

// why: the daemon announces a change on its event stream, and the console reads again after it.
function announce(view: ReturnType<typeof renderConsole>, name: string) {
  view.events.push(name, event(name));
}

const DRAIN = "/v1/workers/*/drain";

describe("the Fleet page", () => {
  it("shows slots with accessible state counts, squares through ten and a meter with a printed fraction above ten", async () => {
    const cases = [
      { name: "zero", limit: 0, states: [] },
      { name: "ten", limit: 10, states: ["leased", "leased", "absent", "quarantined"] },
      { name: "twenty", limit: 20, states: ["leased", "leased", "absent", "quarantined"] },
    ] as const;
    const base = worker().capacity!;
    ofWorkers(
      cases.map(({ limit, name, states }) =>
        worker({
          capacity: {
            android: base.android,
            global: { ...base.global, maxRunning: limit },
            ios: { ...base.ios, limit, maxRunning: limit },
          },
          devices: states.map((state, index) => device({ id: `dev_${name}_${index}`, state })),
          id: `wrk_${name}`,
          label: name,
        }),
      ),
    );
    await screen.findByRole("link", { name: "zero" });

    expect(within(cardOf("zero")).queryByRole("img")).not.toBeInTheDocument();
    expect(within(cardOf("zero")).getAllByText("—")).toHaveLength(3);

    const ten = within(cardOf("ten")).getByRole("img", {
      name: "iOS: 2 leased, 1 absent, 1 quarantined, 6 free",
    });
    expect(ten).toBeVisible();
    expect(ten).toHaveTextContent("");
    expect(within(ten).getAllByTitle(/./)).toHaveLength(10);
    expect(within(ten).getAllByTitle("iPhone 16 18.4, absent")).toHaveLength(1);
    expect(within(ten).getAllByTitle("iPhone 16 18.4, quarantined")).toHaveLength(1);
    expect(ten.querySelector("[style*='--load-bar']")).toBeNull();
    expect(within(cardOf("ten")).getAllByText("—")).toHaveLength(3);

    const twenty = within(cardOf("twenty")).getByRole("img", {
      name: "2 leased, 1 absent, 1 quarantined, 16 free",
    });
    expect(twenty).toBeVisible();
    expect(twenty).toHaveTextContent("2 / 20");
    expect(within(twenty).queryAllByTitle(/./)).toHaveLength(0);
    expect(twenty.querySelectorAll("[style*='--load-bar']")).toHaveLength(1);
    expect(twenty.querySelector("[style*='--load-bar']")).toHaveStyle("--load-bar: 10%");
    expect(within(cardOf("twenty")).getAllByText("—")).toHaveLength(3);
  });

  it("shows every worker as a card or a tile with its name, state word, slots and leases, and the amended Add worker link", async () => {
    ofWorkers([
      worker({
        devices: [device({ id: "dev_a", state: "leased" })],
        host: MAC,
        id: "wrk_a",
        label: "worker-a",
        leases: [lease({ deviceId: "dev_a", id: "lse_a" })],
        load: load(12, 50, 40),
      }),
      worker({
        drained: true,
        host: MAC,
        id: "wrk_b",
        label: "worker-b",
        leases: [],
        load: load(12, 50, 40),
      }),
      worker({
        connection: "incompatible",
        id: "wrk_old",
        label: "old-worker",
        lastSeenAt: NOW,
        protocol: { gateway: { max: 77, min: 77 }, worker: { max: 1, min: 1 } },
      }),
    ]);
    await screen.findByRole("link", { name: "worker-a" });

    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Add worker" })).toHaveAttribute(
      "href",
      "https://callstackincubator.github.io/simlock/docs/gateway/joining-workers",
    );
    expect(screen.getByRole("region", { name: "Needs attention" })).toHaveTextContent("old-worker");
    const a = cardOf("worker-a");
    for (const text of ["worker-a", "macOS 26.0", "1 lease", "1 / 6"]) {
      expect(a).toHaveTextContent(text);
    }
    for (const text of ["12%", "50%", "40%"]) expect(a).toHaveTextContent(text);
    const b = cardOf("worker-b");
    for (const text of ["worker-b", "macOS 26.0", "0 leases", "drained"]) {
      expect(b).toHaveTextContent(text);
    }
    const old = cardOf("old-worker");
    expect(old).toHaveTextContent("incompatible");
    expect(within(old).getAllByText("—")).toHaveLength(3);
    for (const card of [a, b]) expect(within(card).getAllByRole("img").length).toBeGreaterThan(0);
  });

  it("the Issues and Busy filters keep the workers they name", async () => {
    const view = ofWorkers([
      worker({ id: "wrk_a", label: "worker-a" }),
      worker({ drained: true, id: "wrk_b", label: "worker-b" }),
      worker({ connection: "disconnected", id: "wrk_c", label: "worker-c" }),
    ]);
    expect(await screen.findByRole("link", { name: "worker-a" })).toBeVisible();

    await view.user.click(screen.getByLabelText("Issues"));
    expect(window.location.pathname + window.location.search).toBe("/fleet?filter=issues");
    expect(screen.getByRole("link", { name: "worker-b" })).toBeVisible();
    expect(screen.getByRole("link", { name: "worker-c" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "worker-a" })).not.toBeInTheDocument();

    await view.user.click(screen.getByLabelText("Busy"));
    expect(await screen.findByText("No worker matches.")).toBeVisible();

    await view.user.click(screen.getByLabelText("All"));
    for (const name of ["worker-a", "worker-b", "worker-c"]) {
      expect(await screen.findByRole("link", { name })).toBeVisible();
    }
  });

  it("the search box filters by any part of the worker's name, id or system, ignoring case, keeps ?q=, and clearing it brings every row back", async () => {
    const workers = [
      worker({ host: MAC, id: "wrk_alpha1234", label: "worker-a" }),
      worker({ host: { ...MAC, os: "Ubuntu" }, id: "wrk_bravo5678", label: "worker-b" }),
    ];
    const view = ofWorkers(workers);
    const search = await screen.findByRole("searchbox", { name: "Search workers" });
    const shown = (name: string) => screen.queryByRole("link", { name });

    await view.user.type(search, "WORKER-A");
    await waitFor(() => expect(shown("worker-b")).not.toBeInTheDocument());
    expect(shown("worker-a")).toBeVisible();
    expect(window.location.search).toBe("?q=WORKER-A");

    await view.user.clear(search);
    await view.user.type(search, "BRAVO56");
    await waitFor(() => expect(shown("worker-a")).not.toBeInTheDocument());
    expect(shown("worker-b")).toBeVisible();

    await view.user.clear(search);
    await view.user.type(search, "ACOS 2");
    await waitFor(() => expect(shown("worker-a")).toBeVisible());
    expect(shown("worker-b")).not.toBeInTheDocument();
    await view.user.clear(search);
    await view.user.type(search, "UBUNTU");
    await waitFor(() => expect(shown("worker-a")).not.toBeInTheDocument());
    expect(shown("worker-b")).toBeVisible();

    await view.user.clear(search);
    await view.user.type(search, "no such worker");
    expect(await screen.findByText("No worker matches.")).toBeVisible();

    view.unmount();
    ofWorkers(workers, window.location.pathname + window.location.search);
    expect(await screen.findByRole("searchbox", { name: "Search workers" })).toHaveValue(
      "no such worker",
    );
    expect(await screen.findByText("No worker matches.")).toBeVisible();

    await view.user.clear(screen.getByRole("searchbox", { name: "Search workers" }));
    expect(await screen.findByRole("link", { name: "worker-a" })).toBeVisible();
    expect(screen.getByRole("link", { name: "worker-b" })).toBeVisible();
    expect(window.location.pathname + window.location.search).toBe("/fleet");
  });
});

describe("Fleet worker actions", () => {
  it("on a single host no Fleet menu or worker page offers Drain, Undrain or Remove", async () => {
    const solo = worker({ id: "wrk_solo", label: "solo" });
    const view = renderConsole({
      mode: "worker",
      path: "/fleet",
      routes: { "/v1/workers": { body: { workers: [solo] } } },
    });
    await screen.findByRole("link", { name: "solo" });
    const card = cardOf("solo");

    await view.user.pointer({ keys: "[MouseRight]", target: card });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();

    await view.user.click(within(card).getByRole("link", { name: "solo" }));
    expect(await screen.findByRole("heading", { level: 1 })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^(Drain|Undrain|Remove)/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it("a worker is drained from Fleet with no dialog, and Undo undrains it", async () => {
    let drained = false;
    const view = renderConsole({
      path: "/fleet",
      routes: {
        "/v1/workers": () => ({
          body: { workers: [worker({ drained, id: "wrk_d", label: "drain-a" })] },
        }),
        [`DELETE ${DRAIN}`]: () => {
          drained = false;
          return { body: {} };
        },
        [`POST ${DRAIN}`]: () => {
          drained = true;
          return { body: {} };
        },
      },
    });
    await screen.findByRole("link", { name: "drain-a" });
    expect(cardOf("drain-a")).not.toHaveTextContent("drained");

    await view.user.click(screen.getByRole("button", { name: "Actions for drain-a" }));
    await view.user.click(screen.getByRole("menuitem", { name: "Drain" }));
    expect(await screen.findByText("drain-a drained")).toBeVisible();
    expect(
      screen.getByText("Its leases keep running. New leases go to other workers."),
    ).toBeVisible();
    expect(screen.queryByRole("alertdialog", { name: /\?$/ })).not.toBeInTheDocument();
    announce(view, "worker.drain-started");
    await waitFor(() => expect(cardOf("drain-a")).toHaveTextContent("drained"));

    await view.user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("drain-a takes leases again")).toBeVisible();
    announce(view, "worker.drain-ended");
    await waitFor(() => expect(cardOf("drain-a")).not.toHaveTextContent("drained"));
  });

  it("a stopped worker is removed from its page once its name is typed exactly, and a connected worker offers no Remove", async () => {
    let workers = [
      worker({ connection: "disconnected", id: "wrk_g", label: "gone-a" }),
      worker({ id: "wrk_l", label: "live-b" }),
    ];
    const view = renderConsole({
      path: "/fleet",
      routes: {
        "/v1/workers": () => ({ body: { workers } }),
        "DELETE /v1/workers/*": () => {
          workers = workers.filter((w) => w.id !== "wrk_g");
          return { body: {} };
        },
      },
    });
    await screen.findByRole("link", { name: "gone-a" });

    await view.user.click(screen.getByRole("button", { name: "Actions for live-b" }));
    expect(screen.getByRole("menuitem", { name: "Drain" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Remove worker" })).not.toBeInTheDocument();
    await view.user.keyboard("{Escape}");

    expect(within(cardOf("gone-a")).queryByRole("button")).not.toBeInTheDocument();
    await view.user.click(within(cardOf("gone-a")).getByRole("link", { name: "Details" }));
    await view.user.click(await screen.findByRole("button", { name: "Actions for gone-a" }));
    await view.user.click(screen.getByRole("menuitem", { name: "Remove worker" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove gone-a?" });
    expect(dialog).toHaveTextContent(
      "It leaves the fleet and its devices are forgotten. It can join again with a worker token. Type gone-a to confirm.",
    );
    const remove = within(dialog).getByRole("button", { name: "Remove worker" });
    const typed = within(dialog).getByRole("textbox");
    expect(remove).toBeDisabled();
    for (const wrong of ["gone-", "gone-a ", "Gone-A"]) {
      await view.user.clear(typed);
      await view.user.type(typed, wrong);
      expect(remove).toBeDisabled();
    }
    await view.user.clear(typed);
    await view.user.type(typed, "gone-a");
    expect(remove).toBeEnabled();

    await view.user.click(remove);
    expect(await screen.findByText("gone-a removed")).toBeVisible();
    announce(view, "worker.removed");
    await view.user.click(
      within(screen.getByRole("navigation", { name: "Console" })).getByRole("link", {
        name: "Fleet",
      }),
    );
    expect(await screen.findByRole("link", { name: "live-b" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "gone-a" })).not.toBeInTheDocument();
  });

  it("an item's menu entries are disabled while its action is in flight, and a click on one sends nothing", async () => {
    let drained = false;
    let answerDrain: () => void = () => undefined;
    let answerUndrain: () => void = () => undefined;
    const held = (done: (release: () => void) => void, to: boolean): Promise<Answer> =>
      new Promise((resolve) => {
        done(() => {
          drained = to;
          resolve({ body: {} });
        });
      });
    const routes: Routes = {
      "/v1/inbox": () => ({
        body: {
          items: drained
            ? [
                workerItem(
                  "drained",
                  "Needs a look",
                  worker({ drained, id: "wrk_b", label: "busy-a" }),
                ),
              ]
            : [],
        },
      }),
      "/v1/workers": () => ({
        body: { workers: [worker({ drained, id: "wrk_b", label: "busy-a" })] },
      }),
      [`DELETE ${DRAIN}`]: () =>
        held((release) => {
          answerUndrain = release;
        }, false),
      [`POST ${DRAIN}`]: () =>
        held((release) => {
          answerDrain = release;
        }, true),
    };
    const view = renderConsole({ path: "/fleet", routes });
    const menuButton = await screen.findByRole("button", { name: "Actions for busy-a" });
    await view.user.click(menuButton);
    await view.user.click(screen.getByRole("menuitem", { name: "Drain" }));
    await waitFor(() => expect(view.callsTo("POST", "/v1/workers/wrk_b/drain")).toHaveLength(1));

    await view.user.click(menuButton);
    const entry = await screen.findByRole("menuitem", { name: "Drain" });
    expect(entry).toHaveAttribute("aria-disabled", "true");
    await view.user.click(entry);
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(view.callsTo("POST", "/v1/workers/wrk_b/drain")).toHaveLength(1);

    answerDrain();
    expect(await screen.findByText("busy-a drained")).toBeVisible();
    announce(view, "worker.drain-started");
    await waitFor(() =>
      expect(within(cardOf("busy-a")).getByRole("button", { name: "Undrain" })).toBeEnabled(),
    );
    expect(view.callsTo("POST", "/v1/workers/wrk_b/drain")).toHaveLength(1);

    await view.user.click(within(cardOf("busy-a")).getByRole("link", { name: "Details" }));
    const pageButton = await screen.findByRole("button", { name: "Undrain" });
    await view.user.click(pageButton);
    await waitFor(() => expect(view.callsTo("DELETE", "/v1/workers/wrk_b/drain")).toHaveLength(1));
    await waitFor(() => expect(pageButton).toBeDisabled());
    await view.user.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: /Inbox/ }),
    );
    const fix = await screen.findByRole("button", { name: "Undrain" });
    expect(fix).toBeDisabled();
    await view.user.click(fix);
    expect(view.callsTo("DELETE", "/v1/workers/wrk_b/drain")).toHaveLength(1);

    answerUndrain();
    expect(await screen.findByText("busy-a takes leases again")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/workers/wrk_b/drain")).toHaveLength(1);
  });
});
