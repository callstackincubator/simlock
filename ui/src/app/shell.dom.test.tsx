import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderConsole } from "../test/console";

const PAGES = [
  { label: "Overview", path: "/" },
  { label: "Inbox", path: "/inbox" },
  { label: "Fleet", path: "/fleet" },
  { label: "Leases", path: "/leases" },
  { label: "Queue", path: "/queue" },
  { label: "Baselines", path: "/baselines" },
  { label: "Activity", path: "/activity" },
  { label: "Usage", path: "/usage" },
  { label: "Settings", path: "/settings" },
] as const;

const GROUPS = [
  { label: "Operate", links: ["Fleet", "Leases", "Queue", "Baselines"] },
  { label: "Observe", links: ["Activity", "Usage"] },
  { label: "Settings", links: ["Settings"] },
] as const;

async function sidebar() {
  return screen.findByRole("navigation", { name: "Console" });
}

function title() {
  return screen.getByRole("heading", { level: 1 });
}

// why: happy-dom sizes its window through this one call, and its type is not on `window`.
function resizeWindow(width: number, height: number): void {
  const { happyDOM } = window as unknown as {
    happyDOM: { setViewport(size: { height: number; width: number }): void };
  };
  happyDOM.setViewport({ height, width });
}

afterEach(() => {
  // why: a test that narrowed the window must not leave it narrow for the next.
  resizeWindow(1280, 720);
});

describe("the sidebar", () => {
  it("shows Overview and Inbox, then the Operate group, then the Observe group, then Settings, each with its label", async () => {
    renderConsole();
    const nav = await sidebar();

    expect(within(nav).getAllByRole("link")).toHaveLength(PAGES.length);
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(PAGES.map((entry) => entry.label));
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(PAGES.map((entry) => entry.path));

    expect(within(nav).getAllByRole("group")).toHaveLength(GROUPS.length);
    for (const group of GROUPS) {
      const section = within(nav).getByRole("group", { name: group.label });
      expect(within(nav).getByText(group.label, { selector: "p" })).toBeVisible();
      expect(
        within(section)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual([...group.links]);
    }
    expect(within(nav).getAllByRole("link", { name: "Overview" })).toHaveLength(1);
    expect(within(nav).queryAllByRole("link", { name: "Inbox" })).toHaveLength(1);
    expect(
      within(nav)
        .getAllByRole("group")
        .flatMap((group) => within(group).queryAllByRole("link", { name: "Inbox" })),
    ).toHaveLength(0);
  });

  it("moves between pages and the page URL follows", async () => {
    const { user } = renderConsole();
    const nav = await sidebar();

    for (const entry of PAGES) {
      await user.click(within(nav).getByRole("link", { name: entry.label }));
      expect(window.location.pathname).toBe(entry.path);
      expect(await screen.findByRole("heading", { level: 1, name: entry.label })).toBeVisible();
      expect(nav.querySelector("[aria-current='page']")).toHaveTextContent(entry.label);
    }

    const [before, last] = PAGES.slice(-2);
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe(before?.path));
    await waitFor(() =>
      expect(nav.querySelector("[aria-current='page']")).toHaveTextContent(before?.label ?? ""),
    );
    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe(last?.path));
    await waitFor(() =>
      expect(nav.querySelector("[aria-current='page']")).toHaveTextContent(last?.label ?? ""),
    );
  });

  it.each([
    ["/fleet", "Fleet"],
    ["/queue", "Queue"],
    ["/activity", "Activity"],
    ["/workers", "Page not found"],
    ["/waiting", "Page not found"],
    ["/events", "Page not found"],
  ])("%s opens the page titled %s", async (path, heading) => {
    renderConsole({ path });
    await screen.findByRole("heading", { level: 1, name: heading });

    expect(title()).toHaveTextContent(heading);
  });

  it("collapses to icons on request, keeps every link's name, and stays collapsed on every page and after a reload", async () => {
    const { unmount, user } = renderConsole();
    const nav = await sidebar();
    const fleet = () => within(nav).getByRole("link", { name: "Fleet" });
    expect(within(nav).getAllByRole("button", { name: "Collapse sidebar" })).toHaveLength(1);
    expect(fleet()).not.toHaveAttribute("title");

    await user.click(within(nav).getByRole("button", { name: "Collapse sidebar" }));

    const expand = within(nav).getByRole("button", { name: "Expand sidebar" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    for (const entry of PAGES) {
      // why: the label is hidden by style when collapsed, so each link is named by its title.
      expect(within(nav).getByRole("link", { name: entry.label })).toHaveAttribute(
        "title",
        entry.label,
      );
    }

    await user.click(within(nav).getByRole("link", { name: "Leases" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
    expect(within(nav).getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    unmount();
    renderConsole({ path: "/leases" });
    const reloaded = await sidebar();
    expect(within(reloaded).getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    expect(within(reloaded).getByRole("link", { name: "Fleet" })).toHaveAttribute("title", "Fleet");

    await user.click(within(reloaded).getByRole("button", { name: "Expand sidebar" }));
    expect(within(reloaded).getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    expect(within(reloaded).getByRole("link", { name: "Fleet" })).not.toHaveAttribute("title");
  });

  it("starts collapsed in a window narrower than 1280px, until the operator chooses", async () => {
    resizeWindow(1100, 900);
    const { unmount, user } = renderConsole();
    const nav = await sidebar();

    expect(within(nav).getByRole("button", { name: "Expand sidebar" })).toBeVisible();
    await user.click(within(nav).getByRole("button", { name: "Expand sidebar" }));
    expect(within(nav).getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

    unmount();
    renderConsole();
    expect(within(await sidebar()).getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  it("reads only /v1/inbox for its count on every page, and the Inbox page reads no leases, tokens or requests", async () => {
    const { callsTo, user } = renderConsole({ path: "/usage" });
    await screen.findByRole("heading", { level: 1, name: "Usage" });
    await waitFor(() => expect(callsTo("GET", "/v1/inbox")).toHaveLength(1));

    // why: the token check at start reads /v1/workers outside the query layer, so two are allowed.
    expect(callsTo("GET", "/v1/workers").length).toBeLessThanOrEqual(2);
    for (const path of ["/v1/leases", "/v1/tokens", "/v1/lease-requests"]) {
      expect(callsTo("GET", path), path).toHaveLength(0);
    }

    // why: the Inbox page reads the items and the worker list, and the page is drawn once both are in,
    // so a read of leases, tokens or requests would have been asked by then.
    await user.click(within(await sidebar()).getByRole("link", { name: /^Inbox/ }));
    expect(await screen.findByText("Nothing needs you.")).toBeVisible();
    for (const path of ["/v1/leases", "/v1/tokens", "/v1/lease-requests"]) {
      expect(callsTo("GET", path), path).toHaveLength(0);
    }
  });
});
