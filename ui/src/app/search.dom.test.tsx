import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderConsole, type Routes } from "../test/console";
import { device, event, lease, request, token, worker } from "../test/fixtures";

const HOST = worker({ devices: [device()], label: "mac-studio-01" });

// why: a host with one device held by `nav-holder` and one request, `nav-waiter`, waiting behind it.
const QUEUE: Routes = {
  "/v1/lease-requests": { body: { requests: [request({ requesterId: "nav-waiter" })] } },
  "/v1/leases": { body: { leases: [lease({ requesterId: "nav-holder" })] } },
  "/v1/tokens": { body: { tokens: [token()] } },
  "/v1/workers": { body: { workers: [HOST] } },
};

function dialog() {
  return screen.getByRole("dialog", { name: "Search" });
}

function box() {
  return within(dialog()).getByRole("combobox", { name: "Search pages, items and actions" });
}

function highlighted() {
  return dialog().querySelector("[data-highlighted]");
}

function options() {
  return within(dialog()).queryAllByRole("option");
}

describe("the search box", () => {
  it("⌘K and Ctrl+K open the dialog and focus the box, the sidebar button opens it too, and Escape closes it and returns focus", async () => {
    const { user } = renderConsole({ mode: "worker" });
    const button = await screen.findByRole("button", { name: "Search or jump to…" });

    for (const shortcut of ["{Meta>}k{/Meta}", "{Control>}k{/Control}"]) {
      await user.keyboard(shortcut);
      expect(await screen.findByRole("dialog", { name: "Search" })).toBeVisible();
      expect(box()).toHaveFocus();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    }

    await user.click(button);
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeVisible();
    expect(box()).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    expect(button).toHaveFocus();
  });
});

describe("the search list", () => {
  it("the first result is highlighted, ↑ and ↓ move the highlight, and Enter runs the highlighted result", async () => {
    const { user } = renderConsole({ mode: "worker" });
    await screen.findByRole("button", { name: "Search or jump to…" });
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });

    expect(highlighted()).toHaveTextContent("Overview");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(highlighted()).toHaveTextContent("Fleet");
    await user.keyboard("{ArrowUp}");
    expect(highlighted()).toHaveTextContent("Inbox");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(window.location.pathname).toBe("/inbox"));
  });

  it('no results shows "No results for <text>"', async () => {
    const { user } = renderConsole({ mode: "worker" });
    await screen.findByRole("button", { name: "Search or jump to…" });
    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog()).queryByText("No results for", { exact: false })).toBeNull();

    await user.type(box(), "zzz");

    expect(await within(dialog()).findByText("No results for zzz")).toBeVisible();
    expect(options()).toHaveLength(0);
  });
});

describe("the search while data loads", () => {
  it("opened before the data loads, each group says Loading… and fills in while the highlight stays", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderConsole({
      mode: "worker",
      routes: {
        ...QUEUE,
        "/v1/leases": async () => {
          await gate;
          return { body: { leases: [lease({ requesterId: "nav-holder" })] } };
        },
      },
    });
    await screen.findByRole("button", { name: "Search or jump to…" });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "nav");

    await waitFor(() => expect(within(dialog()).getAllByText("Loading…")).toHaveLength(2));
    expect(within(dialog()).queryAllByRole("option", { name: /nav-holder/ })).toHaveLength(0);
    const before = highlighted();
    expect(before).not.toBeNull();
    const [id, text] = [before?.id, before?.textContent];
    expect(id).toBeTruthy();

    release();

    await waitFor(() =>
      expect(within(dialog()).getAllByRole("option", { name: /nav-holder/ })).toHaveLength(2),
    );
    expect(within(dialog()).queryByText("Loading…")).toBeNull();
    expect(dialog().querySelectorAll("[data-highlighted]")).toHaveLength(1);
    expect(highlighted()?.id).toBe(id);
    expect(highlighted()).toHaveTextContent(text ?? "");
  });

  it("a failed read says it could not load", async () => {
    const { user } = renderConsole({
      mode: "worker",
      routes: { ...QUEUE, "/v1/workers": { body: {}, status: 500 } },
    });
    await screen.findByRole("button", { name: "Search or jump to…" });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "nav");

    expect(await within(dialog()).findByText("Could not load workers.")).toBeVisible();
    expect(within(dialog()).getByText("Could not load devices.")).toBeVisible();
    expect(within(dialog()).getAllByRole("option", { name: /nav-holder/ })).toHaveLength(2);
  });
});

describe("the search during live updates", () => {
  it("a live update while the dialog is open changes neither the list nor the highlight, and reopening builds the list again", async () => {
    let requests = [request({ requesterId: "nav-waiter" })];
    const { callsTo, events, user } = renderConsole({
      mode: "worker",
      routes: { ...QUEUE, "/v1/lease-requests": () => ({ body: { requests } }) },
    });
    await screen.findByRole("button", { name: "Search or jump to…" });
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "nav");
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(within(dialog()).queryByText("Loading…")).toBeNull();
    const initial = highlighted()?.id;
    expect(initial).toBeTruthy();
    const before = options().map((option) => option.textContent);
    await user.keyboard("{ArrowDown}");
    expect(highlighted()?.id).not.toBe(initial);
    const moved = highlighted()?.id;

    const reads = callsTo("GET", "/v1/lease-requests").length;
    requests = [
      request({ requesterId: "nav-waiter" }),
      request({ id: "req_2", requesterId: "nav-late" }),
    ];
    events.push("lease.requested", event("lease.requested", { requestId: "req_2" }));
    await waitFor(() => expect(callsTo("GET", "/v1/lease-requests").length).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(options().map((option) => option.textContent)).toEqual(before);
    expect(highlighted()?.id).toBe(moved);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "nav-late");
    await waitFor(() => expect(options()[0]).toHaveTextContent("nav-late"));
  });
});

describe("the search shortcut", () => {
  it("⌘K does nothing while a drawer is open", async () => {
    const { user } = renderConsole({ mode: "worker", path: "/queue/req_1", routes: QUEUE });
    const drawer = await screen.findByRole("dialog");
    expect(drawer).toHaveTextContent("nav-waiter");

    await user.keyboard("{Control>}k{/Control}{Meta>}k{/Meta}");

    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveTextContent("nav-waiter");
  });
});

describe("the search results", () => {
  it("a typed name and Enter go to its page, worker, device, lease or request", async () => {
    const { user } = renderConsole({ mode: "worker", routes: QUEUE });
    await screen.findByRole("button", { name: "Search or jump to…" });

    for (const [typed, path] of [
      ["fleet", "/fleet"],
      ["mac-studio-01", "/fleet/wrk_1"],
      ["iphone", "/fleet/wrk_1/dev_1"],
      ["nav-holder", "/leases/lse_1/"],
      ["nav-waiter", "/queue/req_1"],
    ] as const) {
      // why: ⌘K does nothing while a drawer is open, so the one the last step opened is closed first.
      if (screen.queryAllByRole("dialog").length > 0) await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
      await user.keyboard("{Control>}k{/Control}");
      await user.type(await screen.findByRole("combobox"), typed);
      await waitFor(() => expect(highlighted()).not.toBeNull());
      expect(highlighted()?.textContent?.toLowerCase()).toContain(
        typed.split(/\s+/).at(-1)?.toLowerCase(),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
      expect(window.location.pathname).toBe(path);
    }
  });
});

describe("the search actions", () => {
  it("an action runs as from its menu: drain with its toast and Undo, release and cancel after their confirms, remove after the name is typed", async () => {
    const { callsTo, user } = renderConsole({
      mode: "gateway",
      routes: {
        ...QUEUE,
        "DELETE /v1/workers/*/drain": { status: 200, body: {} },
        "POST /v1/workers/*/drain": { status: 200, body: {} },
        "/v1/leases": {
          body: { leases: [lease({ requesterId: "nav-holder", workerId: "wrk_2" })] },
        },
        "/v1/lease-requests": {
          body: { requests: [request({ requesterId: "nav-waiter", workerId: "wrk_2" })] },
        },
        "/v1/workers": {
          body: {
            workers: [
              worker({ connection: "disconnected", id: "wrk_1", label: "gone-a" }),
              worker({ devices: [device()], id: "wrk_2", label: "live-b" }),
            ],
          },
        },
      },
    });
    await screen.findByRole("button", { name: "Search or jump to…" });
    const run = async (typed: string) => {
      await waitFor(() => expect(screen.queryAllByRole("alertdialog")).toHaveLength(0));
      await user.keyboard("{Control>}k{/Control}");
      await user.type(await screen.findByRole("combobox"), typed);
      await waitFor(() => expect(highlighted()).not.toBeNull());
      expect(highlighted()?.textContent?.toLowerCase()).toContain(
        typed.split(/\s+/).at(-1)?.toLowerCase(),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    };

    await run("drain live-b");
    expect(await screen.findByText("live-b drained")).toBeVisible();
    expect(callsTo("POST", "/v1/workers/wrk_2/drain")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("live-b takes leases again")).toBeVisible();
    expect(callsTo("DELETE", "/v1/workers/wrk_2/drain")).toHaveLength(1);

    await run("remove gone-a");
    const removal = await screen.findByRole("alertdialog", { name: "Remove gone-a?" });
    const remove = within(removal).getByRole("button", { name: "Remove worker" });
    expect(remove).toBeDisabled();
    await user.type(within(removal).getByRole("textbox"), "gone-");
    expect(remove).toBeDisabled();
    await user.type(within(removal).getByRole("textbox"), "a");
    expect(remove).toBeEnabled();
    await user.click(within(removal).getByRole("button", { name: "Keep" }));

    await run("release nav-holder");
    expect(
      await screen.findByRole("alertdialog", { name: "Release nav-holder's lease?" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    await run("cancel nav-waiter");
    expect(
      await screen.findByRole("alertdialog", { name: "Cancel nav-waiter's request?" }),
    ).toBeVisible();
  });
});
