import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderConsole, resizeWindow } from "../../test/console";
import { event, lease, NOW } from "../../test/fixtures";

afterEach(() => {
  resizeWindow(1280, 720);
  document.documentElement.removeAttribute("data-theme");
});

function choices(legend: string) {
  return within(screen.getByRole("group", { name: legend }));
}

describe("Settings", () => {
  it("on a phone shows the stored desktop sidebar choice and saves the one picked", async () => {
    resizeWindow(390, 800);
    window.localStorage.setItem("simlock.sidebar", "narrow");
    const { user } = renderConsole({ path: "/settings" });
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    expect(choices("Sidebar").getByRole("radio", { name: "Collapsed" })).toBeChecked();

    await user.click(choices("Sidebar").getByRole("radio", { name: "Expanded" }));
    expect(window.localStorage.getItem("simlock.sidebar")).toBe("wide");
    expect(choices("Sidebar").getByRole("radio", { name: "Expanded" })).toBeChecked();

    await user.click(choices("Sidebar").getByRole("radio", { name: "Collapsed" }));
    expect(window.localStorage.getItem("simlock.sidebar")).toBe("narrow");
  });
});

async function open(user: ReturnType<typeof renderConsole>["user"], page: string) {
  await user.click(
    within(screen.getByRole("navigation", { name: "Console" })).getByRole("link", { name: page }),
  );
  await screen.findByRole("heading", { level: 1, name: page });
}

async function choose(
  user: ReturnType<typeof renderConsole>["user"],
  legend: string,
  label: string,
) {
  await user.click(choices(legend).getByRole("radio", { name: label }));
}

const LONG_HOLDER = "claude-code:0123456789abcdef0123456789abcdef";

function leases(count: number) {
  return Array.from({ length: count }, (_, index) =>
    lease({
      deviceId: `dev_${index + 1}`,
      grantedAt: NOW - 3_600_000 + index * 1_000,
      id: `lse_${index + 1}`,
      requesterId: LONG_HOLDER,
    }),
  );
}

describe("a Settings choice, seen on the page it changes", () => {
  it("rows per page sets the first page of a list: 50 shows 1–50 of 60 on Leases, 25 shows 1–25", async () => {
    const { user } = renderConsole({
      path: "/settings",
      routes: { "/v1/leases": { body: { leases: leases(60) } } },
    });
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    await choose(user, "Rows per page", "50");
    await open(user, "Leases");
    const pages = await screen.findByRole("navigation", { name: "Leases pages" });
    expect(pages).toHaveTextContent("1–50 of 60");

    await open(user, "Settings");
    await choose(user, "Rows per page", "25");
    await open(user, "Leases");
    expect(await screen.findByRole("navigation", { name: "Leases pages" })).toHaveTextContent(
      "1–25 of 60",
    );
  });

  it("the default range is what Overview and Activity show with no ?range=, and picking 1 h then writes ?range=1h", async () => {
    const minutesAgo = (minutes: number) => ({ timestamp: NOW - minutes * 60_000 });
    const { callsTo, user } = renderConsole({
      path: "/settings",
      routes: {
        "/v1/events": {
          body: {
            events: [
              event("lease.granted", {}, minutesAgo(1)),
              event("lease.renewed", {}, minutesAgo(180)),
            ],
          },
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    await choose(user, "Default range for Overview and Activity", "24 h");
    await open(user, "Overview");
    expect(await screen.findByRole("radio", { name: "24 h" })).toBeChecked();
    expect(window.location.search).toBe("");
    await waitFor(() =>
      expect(
        callsTo("GET", "/v1/stats").map((call) => new URLSearchParams(call.search).get("since")),
      ).toContain("24h"),
    );
    expect(
      callsTo("GET", "/v1/stats").map((call) => new URLSearchParams(call.search).get("since")),
    ).not.toContain("1h");

    await user.click(screen.getByRole("radio", { name: "1 h" }));
    await waitFor(() => expect(window.location.search).toBe("?range=1h"));

    await open(user, "Activity");
    expect(await screen.findByRole("radio", { name: "24 h" })).toBeChecked();
    expect(window.location.search).toBe("");
    // why: the lease renewed three hours ago counts only in a range wider than the hour.
    const kinds = within(screen.getByRole("group", { name: "Kind" }));
    await waitFor(() =>
      expect(kinds.getByRole("checkbox", { name: /^Leases/ })).toHaveAccessibleName(/Leases\s*2/),
    );
  });

  it("the theme sets data-theme on the page: Dark and Light set it, System removes it", async () => {
    const { user } = renderConsole({ path: "/settings" });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const root = document.documentElement;

    await choose(user, "Theme", "Dark");
    expect(root).toHaveAttribute("data-theme", "dark");
    await choose(user, "Theme", "Light");
    expect(root).toHaveAttribute("data-theme", "light");
    await choose(user, "Theme", "System");
    expect(root).not.toHaveAttribute("data-theme");
  });

  it("holder ids Full shows a long holder whole on Leases, and Short cuts it in the middle", async () => {
    const { user } = renderConsole({
      path: "/settings",
      routes: { "/v1/leases": { body: { leases: leases(1) } } },
    });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const table = async () => within(await screen.findByRole("table"));

    await choose(user, "Holder ids", "Full");
    await open(user, "Leases");
    expect((await table()).getByText(LONG_HOLDER)).toBeVisible();

    await open(user, "Settings");
    await choose(user, "Holder ids", "Short");
    await open(user, "Leases");
    expect((await table()).getByText("claude-code:0123456789abc\u2026abcdef")).toBeVisible();
    expect((await table()).queryByText(LONG_HOLDER)).toBeNull();
  });
});

describe("the Daemon card", () => {
  it.each([
    [403, "FORBIDDEN", "Your token cannot read this daemon's settings."],
    [404, "NOT_FOUND", "This daemon is too old to report its settings."],
  ])(
    "names why it shows no settings when GET /v1/config answers %i",
    async (status, code, message) => {
      renderConsole({
        path: "/settings",
        routes: { "/v1/config": { body: { error: { code, message: "Refused" } }, status } },
      });

      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.queryByRole("table", { name: "Daemon settings" })).toBeNull();
    },
  );
});
