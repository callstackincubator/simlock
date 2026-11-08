import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Routes, renderConsole } from "../../test/console";
import { lease, leaseDetails, NOW } from "../../test/fixtures";
import { returnToTab } from "../../test/tab";

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

// why: one holder, one lease per device, granted a second apart, so the table's order is the order
// of the numbers.
function leasesNumbered(count: number) {
  return Array.from({ length: count }, (_, index) =>
    lease({
      deviceId: `dev_${pad(index + 1)}`,
      grantedAt: NOW - 3_600_000 + index * 1_000,
      id: `lse_${pad(index + 1)}`,
      ownerId: "tok_load",
      requesterId: "tok_load",
    }),
  );
}

function listing(count: number | (() => number)): Routes {
  const size = () => (typeof count === "number" ? count : count());
  return {
    "/v1/leases": () => ({ body: { leases: leasesNumbered(size()) } }),
    "/v1/leases/*": ({ path }) => ({
      body: { lease: leaseDetails({ id: path.slice("/v1/leases/".length) }) },
    }),
  };
}

function ids(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `lse_${pad(from + index)}`);
}

function rowIds(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("link")
    .map((link) => {
      const path = (link.getAttribute("href") ?? "").split("?")[0] ?? "";
      return decodeURIComponent(path.slice("/leases/".length).replace(/\/$/, ""));
    });
}

async function pager() {
  return screen.findByRole("navigation", { name: "Leases pages" });
}

function range() {
  return screen.getByRole("navigation", { name: "Leases pages" }).querySelector(".pager-range");
}

function pathAndSearch() {
  return `${window.location.pathname}${window.location.search}`;
}

describe("a long list of leases", () => {
  it("shows 25 rows of 1,240 leases and the pager says 1–25 of 1,240", async () => {
    renderConsole({ path: "/leases", routes: listing(1_240) });

    const nav = await pager();

    expect(rowIds()).toEqual(ids(1, 25));
    expect(within(nav).getByText("1–25 of 1,240")).toBeVisible();
    expect(nav).toHaveTextContent("Page 1 of 50");
  });

  it("next and previous move by one page and stop at the ends", async () => {
    const { user } = renderConsole({ path: "/leases", routes: listing(60) });
    const nav = await pager();
    const next = within(nav).getByRole("button", { name: "Next" });
    const previous = within(nav).getByRole("button", { name: "Previous" });

    expect(previous).toHaveAttribute("aria-disabled", "true");
    const start = window.history.length;
    await user.click(previous);
    expect(range()).toHaveTextContent("1–25 of 60");
    expect(window.history.length).toBe(start);

    await user.click(next);
    await waitFor(() => expect(range()).toHaveTextContent("26–50 of 60"));
    expect(rowIds()).toEqual(ids(26, 50));
    await user.click(next);
    await waitFor(() => expect(range()).toHaveTextContent("51–60 of 60"));
    expect(rowIds()).toEqual(ids(51, 60));
    expect(next).toHaveAttribute("aria-disabled", "true");
    const entries = window.history.length;
    await user.click(next);
    expect(range()).toHaveTextContent("51–60 of 60");
    expect(window.location.search).toBe("?page=3");
    expect(window.history.length).toBe(entries);

    await user.click(previous);
    await waitFor(() => expect(range()).toHaveTextContent("26–50 of 60"));
    await user.click(previous);
    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 60"));
    expect(rowIds()).toEqual(ids(1, 25));
    expect(pathAndSearch()).toBe("/leases");
  });

  it("choosing 50 per page shows 50 rows and writes size=50 to the URL", async () => {
    const { user } = renderConsole({ path: "/leases", routes: listing(1_240) });
    const nav = await pager();

    await user.selectOptions(within(nav).getByLabelText("Per page"), "50");

    await waitFor(() => expect(range()).toHaveTextContent("1–50 of 1,240"));
    expect(rowIds()).toEqual(ids(1, 50));
    expect(pathAndSearch()).toBe("/leases?size=50");
  });

  it("choosing 50 per page from rows 101 to 125 goes to the page that still starts with row 101", async () => {
    const { user } = renderConsole({ path: "/leases?page=5", routes: listing(1_240) });
    const nav = await pager();
    expect(range()).toHaveTextContent("101–125 of 1,240");

    await user.selectOptions(within(nav).getByLabelText("Per page"), "50");

    await waitFor(() => expect(range()).toHaveTextContent("101–150 of 1,240"));
    expect(new URLSearchParams(window.location.search).toString()).toBe("page=3&size=50");
  });

  it("opening a URL with page=3 shows the third page", async () => {
    renderConsole({ path: "/leases?page=3", routes: listing(1_240) });

    await pager();

    expect(range()).toHaveTextContent("51–75 of 1,240");
    expect(rowIds()).toEqual(ids(51, 75));
    expect(pathAndSearch()).toBe("/leases?page=3");
  });

  it("when a refresh shrinks the list below the current page, the last page shows", async () => {
    let count = 60;
    renderConsole({ path: "/leases?page=3", routes: listing(() => count) });
    await pager();
    expect(range()).toHaveTextContent("51–60 of 60");

    count = 30;
    await returnToTab();

    await waitFor(() => expect(range()).toHaveTextContent("26–30 of 30"));
    expect(rowIds()).toEqual(ids(26, 30));
    expect(pathAndSearch()).toBe("/leases?page=2");
  });

  it("a focused link in the list keeps its focus, and its row its place, across two refreshes", async () => {
    let served = 0;
    const { user } = renderConsole({
      path: "/leases?page=2",
      routes: {
        ...listing(60),
        "/v1/leases": () => {
          served += 1;
          return { body: { leases: leasesNumbered(60) } };
        },
      },
    });
    await pager();
    const row = within(screen.getByRole("table")).getAllByRole("row")[3] as HTMLElement;
    const link = within(row).getByRole("link");
    const expires = row.querySelector("td:last-child") as HTMLElement;
    expect(link).toHaveAttribute("href", "/leases/lse_0028/?page=2");
    link.focus();
    expect(link).toHaveFocus();
    // why: the element itself is marked: a link drawn again in its place would not carry the mark.
    (link as unknown as { kept?: boolean }).kept = true;

    // why: twice, the daemon answers once more and then the row's countdown moves, so a render follows.
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const since = served;
      await returnToTab();
      await waitFor(() => expect(served).toBeGreaterThan(since));
      const before = expires.textContent;
      vi.setSystemTime(Date.now() + 5_000);
      await waitFor(() => expect(expires.textContent).not.toBe(before), { timeout: 3_000 });
    }

    expect(link).toHaveFocus();
    expect((link as unknown as { kept?: boolean }).kept).toBe(true);
    expect(rowIds()).toEqual(ids(26, 50));
    await user.keyboard("{Enter}");
    expect(pathAndSearch()).toBe("/leases/lse_0028/?page=2");
    expect(await screen.findByRole("region", { name: "Lease" })).toBeVisible();
  });

  it("changing the leases search goes back to page 1", async () => {
    const { user } = renderConsole({ path: "/leases?page=2", routes: listing(60) });
    await pager();
    expect(range()).toHaveTextContent("26–50 of 60");

    await user.type(screen.getByRole("searchbox", { name: "Search leases" }), "lse_00");

    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 60"));
    expect(pathAndSearch()).toBe("/leases?q=lse_00");
  });

  it("hides the pager when every row fits on one page", async () => {
    let count = 25;
    renderConsole({ path: "/leases", routes: listing(() => count) });
    expect(await screen.findAllByRole("row")).toHaveLength(1 + 25);
    expect(screen.queryByRole("navigation", { name: "Leases pages" })).not.toBeInTheDocument();

    count = 26;
    await returnToTab();

    await waitFor(() => expect(range()).toHaveTextContent("1–25 of 26"));
  });
});

// why: the window's width decides whether a lease opens beside the table or as a drawer.
function setViewport(size: { readonly height: number; readonly width: number }) {
  (window as unknown as { happyDOM: { setViewport: (size: object) => void } }).happyDOM.setViewport(
    size,
  );
}

// why: a pointer press on the dim layer, which is no focus target: user-event would move focus to
// the nearest focusable ancestor, where a browser leaves it in the page.
function clickOutside(target: HTMLElement) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
}

describe("a lease's drawer on a narrower window", () => {
  afterEach(() => {
    setViewport({ height: 720, width: 1280 });
  });

  it.each(["Escape", "the close button", "the dim layer"] as const)(
    "%s closes a lease's drawer and returns to /leases keeping ?page=2&size=25, with focus on the row that opened it and Back not reopening it",
    async (how) => {
      // why: below 1280px wide a lease opens as a drawer, which Escape, its close button and its dim layer close.
      setViewport({ height: 800, width: 1100 });
      const { user } = renderConsole({
        path: "/leases?page=2&size=25",
        routes: listing(60),
      });
      await pager();
      const opener = screen
        .getAllByRole("link")
        .find((link) => link.getAttribute("href")?.startsWith("/leases/lse_0028/")) as HTMLElement;
      await user.click(opener);
      const drawer = await screen.findByRole("dialog");
      expect(pathAndSearch()).toBe("/leases/lse_0028/?page=2&size=25");

      if (how === "Escape") await user.keyboard("{Escape}");
      else if (how === "the close button")
        await user.click(within(drawer).getByRole("button", { name: "Close" }));
      else clickOutside(document.querySelector(".drawer-dim") as HTMLElement);

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(pathAndSearch()).toBe("/leases?page=2&size=25");
      await waitFor(() => expect(opener).toHaveFocus());
      act(() => window.history.back());
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(window.location.pathname).not.toMatch(/^\/leases\/./);
    },
  );
});
