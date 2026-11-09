import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderConsole } from "../../test/console";
import { event, NOW, request, worker } from "../../test/fixtures";

const IOS_16 = { model: "iPhone 16", osVersion: "18.4", platform: "ios" } as const;

function row(requester: string): HTMLElement {
  const table = screen.getByRole("table");
  const found = within(table)
    .getAllByRole("row")
    .find((candidate) => (candidate.textContent ?? "").includes(requester));
  if (found === undefined) throw new Error(`no row for ${requester}`);
  return found;
}

describe("the Queue page", () => {
  it("lists each waiting request with place, requester, device, stage, why and wait, and a row opens its drawer with the inspector's facts", async () => {
    const { user } = renderConsole({
      path: "/queue",
      routes: {
        "/v1/lease-requests": {
          body: {
            requests: [
              request({
                createdAt: NOW - 75_000,
                id: "req_b",
                queuePosition: 1,
                reason: "device-limit",
                requesterId: "agent-b",
                spec: IOS_16,
              }),
              request({
                createdAt: NOW - 30_000,
                id: "req_c",
                queuePosition: 2,
                reason: "behind-earlier-request",
                requesterId: "agent-c",
                spec: { ...IOS_16, mode: "slim" },
              }),
            ],
          },
        },
      },
    });

    await screen.findByRole("table");
    expect(row("agent-b")).toHaveTextContent("#1");
    expect(row("agent-b")).toHaveTextContent("iOS iPhone 16, runtime 18.4");
    expect(row("agent-b")).toHaveTextContent("queued");
    expect(row("agent-c")).toHaveTextContent("#2");
    expect(row("agent-c")).toHaveTextContent("iOS iPhone 16, runtime 18.4, mode slim");
    expect(row("agent-b")).toHaveTextContent("Full: device limit");
    expect(within(row("agent-b")).getAllByRole("cell")[5]).toHaveTextContent(/^(\d+ s|\d+ min)/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/queue");

    await user.click(within(row("agent-c")).getByRole("link", { name: "agent-c" }));

    const drawer = screen.getByRole("dialog", { name: "agent-c" });
    expect(window.location.pathname).toBe("/queue/req_c");
    for (const label of ["Waiting", "Place", "Stage", "Device", "Queue", "Why"]) {
      expect(within(drawer).getAllByText(label, { selector: "dt" })).toHaveLength(1);
    }
    expect(drawer).toHaveTextContent("2 of 2");
    expect(drawer).toHaveTextContent("iOS iPhone 16, runtime 18.4, mode slim");
    const waited = () => within(drawer).getAllByRole("definition")[0]?.textContent;
    const before = waited();
    vi.setSystemTime(NOW + 5_000);
    await waitFor(() => expect(waited()).not.toBe(before), { timeout: 3_000 });
  });

  it("on a gateway, a worker's request links to that worker and the fleet queue's request names the gateway's queue", async () => {
    const { user } = renderConsole({
      path: "/queue",
      routes: {
        "/v1/lease-requests": {
          body: {
            requests: [
              request({
                id: "req_local",
                queuePosition: 1,
                requesterId: "local-b",
                spec: IOS_16,
                workerId: "wrk_a",
              }),
              request({
                id: "req_fleet",
                queuePosition: 1,
                requesterId: "fleet-c",
                spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
              }),
            ],
          },
        },
        "/v1/workers": { body: { workers: [worker({ id: "wrk_a", label: "worker-a" })] } },
      },
    });
    await screen.findByRole("table");

    await user.click(within(row("local-b")).getByRole("link"));
    const local = screen.getByRole("dialog", { name: "local-b" });
    expect(within(local).getByRole("link", { name: "worker-a" })).toBeVisible();
    expect(local).toHaveTextContent("1 of 1");
    await user.keyboard("{Escape}");

    await user.click(within(row("fleet-c")).getByRole("link"));
    const fleet = screen.getByRole("dialog", { name: "fleet-c" });
    expect(fleet).toHaveTextContent("the gateway's queue");
    expect(fleet).toHaveTextContent("iOS iPhone 16, runtime 18.4");
    expect(fleet).toHaveTextContent("queued");
    expect(fleet).toHaveTextContent("1 of 1");
  });

  it("drops a request that is granted while its drawer is open from the list, and the drawer says Request not waiting.", async () => {
    let requests = [request({ id: "req_b", requesterId: "agent-b", spec: IOS_16 })];
    const { events, user } = renderConsole({
      path: "/queue",
      routes: { "/v1/lease-requests": () => ({ body: { requests } }) },
    });
    await screen.findByRole("table");
    await user.click(within(row("agent-b")).getByRole("link"));
    expect(screen.getByRole("dialog", { name: "agent-b" })).toBeVisible();

    requests = [];
    events.push("queue.changed", event("queue.changed"));

    expect(await screen.findByText("Request not waiting.")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.pathname).toBe("/queue"));
    expect(screen.getByText("No requests are waiting.")).toBeVisible();
    expect(screen.queryByText("agent-b")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says a request id that was never waiting is not waiting", async () => {
    renderConsole({ path: "/queue/req_none" });

    expect(
      within(await screen.findByRole("dialog")).getByText("Request not waiting."),
    ).toBeVisible();
  });

  it("replaces the address with /queue when the drawer, loaded directly at a request's address, closes", async () => {
    const { user } = renderConsole({ path: "/queue/req_none" });
    const drawer = await screen.findByRole("dialog");
    const entries = window.history.length;

    await user.keyboard("{Escape}");

    await waitFor(() => expect(drawer).not.toBeInTheDocument());
    expect(window.location.pathname).toBe("/queue");
    expect(window.history.length).toBe(entries);
  });
});
