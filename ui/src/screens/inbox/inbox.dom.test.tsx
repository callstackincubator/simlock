import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InboxItem } from "../../model/inbox";
import { renderConsole } from "../../test/console";
import {
  event,
  inboxDevice,
  inboxLease,
  inboxWorker,
  NOW,
  request,
  worker,
} from "../../test/fixtures";

function drained(id: string, label: string): InboxItem {
  return {
    condition: "drained",
    group: "Needs a look",
    key: `${id}/drained`,
    worker: inboxWorker({ drained: true, id, label }),
  };
}

function disconnected(id: string, label: string, lastSeenAt = NOW - 5_000): InboxItem {
  return {
    condition: "disconnected",
    group: "Broken",
    key: `${id}/disconnected`,
    worker: inboxWorker({ connection: "disconnected", id, label, lastSeenAt }),
  };
}

function incompatible(id: string, label: string): InboxItem {
  return {
    condition: "incompatible",
    group: "Broken",
    key: `${id}/incompatible`,
    worker: inboxWorker({
      connection: "incompatible",
      id,
      label,
      protocol: { gateway: { max: 77, min: 76 }, worker: { max: 70, min: 70 } },
    }),
  };
}

function waiting(requester: string, waitedMs: number): InboxItem {
  return {
    condition: "waiting",
    group: "Needs a look",
    key: `request/${requester}/waiting`,
    request: request({ createdAt: NOW - waitedMs, id: requester, requesterId: requester }),
  };
}

function ending(id: string, leftMs: number): InboxItem {
  return {
    condition: "ending",
    group: "Heads-up",
    key: `lease/${id}/ending`,
    lease: inboxLease({
      deviceId: "dev_stub",
      holder: "tok_stub",
      id,
      model: "dev_stub",
      ttlDeadline: NOW + leftMs,
    }),
  };
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("main")).queryAllByRole("link");
}

function item(condition: string, subject: string): HTMLElement | undefined {
  return rows().find(
    (row) =>
      within(row).queryByRole("img", { name: condition }) !== null &&
      (row.textContent ?? "").includes(subject),
  );
}

function facts(): HTMLElement {
  return screen.getByRole("group", { name: "Facts" });
}

describe("the Inbox view", () => {
  it("lists a drained worker under Needs a look and a disconnected one under Broken, and the chips show one group at a time", async () => {
    const { user } = renderConsole({
      path: "/inbox",
      routes: {
        "/v1/inbox": {
          body: { items: [drained("wrk_a", "worker-a"), disconnected("wrk_b", "worker-b")] },
        },
      },
    });

    const broken = await screen.findByRole("region", { name: "Broken" });
    const needsALook = screen.getByRole("region", { name: "Needs a look" });
    expect(within(broken).getByRole("link", { name: /worker-b/ })).toBeVisible();
    expect(within(needsALook).getByRole("link", { name: /worker-a/ })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Heads-up" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Broken" }));
    expect(screen.getByRole("region", { name: "Broken" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Needs a look" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Needs a look" }));
    expect(screen.getByRole("region", { name: "Needs a look" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Broken" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByRole("region", { name: "Broken" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Needs a look" })).toBeVisible();
  });

  it("shows a waiting request under Needs a look with its requester and the wait", async () => {
    renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": { body: { items: [waiting("long-waiter", 61_000)] } } },
    });

    const needsALook = await screen.findByRole("region", { name: "Needs a look" });
    expect(
      within(needsALook).getByRole("link", { name: /long-waiter has waited 1 min/ }),
    ).toBeVisible();
  });

  it("shows a lease with 4 minutes left under Heads-up with its holder, device and time left", async () => {
    renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": { body: { items: [ending("lease-soon", 4 * 60_000)] } } },
    });

    const headsUp = await screen.findByRole("region", { name: "Heads-up" });
    expect(within(headsUp).getAllByRole("link")).toHaveLength(1);
    expect(
      within(headsUp).getByRole("link", { name: /tok_stub · dev_stub ends in [34]:\d\d/ }),
    ).toBeVisible();
  });

  it("reopens an item whose key holds a . at its address", async () => {
    const routes = {
      "/v1/inbox": { body: { items: [ending("wrk_a.lse_1", 4 * 60_000)] } },
    };
    const first = renderConsole({ path: "/inbox", routes });

    await first.user.click(
      within(await screen.findByRole("region", { name: "Heads-up" })).getByRole("link"),
    );
    const address = window.location.pathname;
    expect(address).toBe(`/inbox/${encodeURIComponent("lease/wrk_a.lse_1/ending")}/`);
    first.unmount();
    renderConsole({ path: address, routes });

    expect(
      await within(await screen.findByRole("dialog")).findByRole("heading", {
        name: "tok_stub · dev_stub",
      }),
    ).toBeVisible();
    expect(window.location.pathname).toBe(address);
  });

  it("opens /inbox/<key> from a row with the what-happened box and the item's details, and says This is no longer in the Inbox. once the item is cleared", async () => {
    let items: InboxItem[] = [drained("wrk_a", "worker-a")];
    const { events, user } = renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": () => ({ body: { items } }) },
    });

    const row = await screen.findByRole("region", { name: "Needs a look" });
    expect(within(row).getByRole("button", { name: "Undrain" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();

    await user.click(item("drained", "worker-a") as HTMLElement);

    expect(window.location.pathname).toBe(`/inbox/${encodeURIComponent("wrk_a/drained")}`);
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "worker-a" })).toBeVisible();
    expect(within(drawer).getByRole("region", { name: "What happened" })).toHaveTextContent(
      "worker-a is drained",
    );
    expect(within(drawer).getByRole("button", { name: "Undrain" })).toBeVisible();
    expect(facts()).toHaveTextContent(/Leases still held\s*0/);
    expect(within(drawer).getByRole("link", { name: "Open worker" })).toHaveAttribute(
      "href",
      "/fleet/wrk_a",
    );

    items = [];
    events.push("worker.undrained", event("worker.undrained", { workerId: "wrk_a" }));

    expect(await within(drawer).findByText("This is no longer in the Inbox.")).toBeVisible();
    expect(within(drawer).queryByRole("region", { name: "What happened" })).not.toBeInTheDocument();
  });

  it("shows the daemon's refusal when /v1/inbox fails, and not Nothing needs you", async () => {
    renderConsole({
      path: "/inbox",
      routes: {
        "/v1/inbox": {
          body: { error: { code: "INTERNAL", message: "The inbox is down." } },
          status: 500,
        },
      },
    });

    expect(await screen.findByText("The inbox is down.")).toBeVisible();
    expect(screen.queryByText("Nothing needs you.")).not.toBeInTheDocument();
  });

  it("adds a worker to the Inbox when it is drained and opens its drawer from the row", async () => {
    let items: InboxItem[] = [];
    const { events, user } = renderConsole({
      path: "/inbox",
      routes: {
        "/v1/inbox": () => ({ body: { items } }),
        "/v1/workers": { body: { workers: [worker({ id: "wrk_b", label: "worker-b" })] } },
      },
    });
    expect(await screen.findByText("Nothing needs you.")).toBeVisible();

    items = [drained("wrk_b", "worker-b")];
    const drain = event("worker.drain-started", { workerId: "wrk_b" });
    events.push("worker.drain-started", drain);

    await waitFor(() => expect(item("drained", "worker-b")).toBeDefined());
    const row = item("drained", "worker-b") as HTMLElement;
    expect(row).toHaveAttribute("href", `/inbox/${encodeURIComponent("wrk_b/drained")}`);
    expect(rows()).toHaveLength(1);
    expect(window.location.pathname).toBe("/inbox");
    await user.click(row);
    expect(
      within(await screen.findByRole("dialog")).getByRole("heading", { name: "worker-b" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Open worker" })).toHaveAttribute(
      "href",
      "/fleet/wrk_b",
    );
    expect(facts()).toHaveTextContent("Leases still held");
    const recent = screen.getByRole("region", { name: "Recent events" });
    expect(
      await within(recent).findByRole("link", { name: /worker\.drain-started/ }),
    ).toHaveAttribute("href", `/activity/${drain.id}`);
  });

  it("removes a worker from the Inbox when it is undrained", async () => {
    let items: InboxItem[] = [drained("wrk_a", "worker-a")];
    const { events } = renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": () => ({ body: { items } }) },
    });
    await waitFor(() => expect(item("drained", "worker-a")).toBeDefined());

    items = [];
    events.push("worker.undrained", event("worker.undrained", { workerId: "wrk_a" }));

    await waitFor(() => expect(item("drained", "worker-a")).toBeUndefined());
    expect(screen.getByText("Nothing needs you.")).toBeVisible();
  });

  it("adds a worker that stops as disconnected, with when it was last seen", async () => {
    let items: InboxItem[] = [];
    const { events, user } = renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": () => ({ body: { items } }) },
    });
    expect(await screen.findByText("Nothing needs you.")).toBeVisible();

    items = [disconnected("wrk_b", "worker-b")];
    events.push("worker.disconnected", event("worker.disconnected", { workerId: "wrk_b" }));

    await waitFor(() => expect(item("disconnected", "worker-b")).toBeDefined());
    expect(item("disconnected", "worker-a")).toBeUndefined();
    await user.click(item("disconnected", "worker-b") as HTMLElement);
    expect(facts()).toHaveTextContent(/Last seen\s*5 s ago/);
  });

  it("lists a quarantined device, a stalled device and a host over its RAM budget, three rows on one host", async () => {
    const device = (state: "quarantined" | "provisioning", id: string) =>
      inboxDevice({ id, state, workerId: "wrk_1" });
    renderConsole({
      path: "/inbox",
      routes: {
        "/v1/inbox": {
          body: {
            items: [
              {
                condition: "quarantined",
                group: "Broken",
                key: "dev_q/quarantined",
                device: device("quarantined", "dev_q"),
              },
              {
                condition: "stalled",
                group: "Needs a look",
                key: "dev_s/stalled",
                device: device("provisioning", "dev_s"),
              },
              {
                condition: "over RAM budget",
                group: "Needs a look",
                key: "wrk_1/over RAM budget",
                limitBytes: 8 * 2 ** 30,
                usedBytes: 9 * 2 ** 30,
                worker: inboxWorker(),
              },
            ] satisfies InboxItem[],
          },
        },
      },
    });

    await screen.findByRole("region", { name: "Broken" });
    expect(item("quarantined", "iPhone 16 on wrk_1")).toBeDefined();
    expect(item("stalled", "iPhone 16 on wrk_1")).toBeDefined();
    expect(item("over RAM budget", "wrk_1")).toBeDefined();
    expect(rows()).toHaveLength(3);
  });

  it.each([
    {
      condition: "incompatible",
      expected: [/Gateway protocol\s*76–77/, /Worker protocol\s*70/],
      subject: "old-worker",
      item: incompatible("wrk_old", "old-worker"),
    },
    {
      condition: "quarantined",
      expected: [/Device\s*dev_q/, /Cause\s*Delete failed: Error: delete failed/],
      subject: "iPhone 16 on worker-a",
      item: {
        condition: "quarantined",
        device: inboxDevice({
          id: "dev_q",
          quarantineCause: { kind: "delete-failed", message: "Error: delete failed" },
          state: "quarantined",
          workerId: "wrk_a",
          workerLabel: "worker-a",
        }),
        group: "Broken",
        key: "dev_q/quarantined",
      } satisfies InboxItem,
    },
    {
      condition: "stalled",
      expected: [/Device\s*dev_s/, /In this state for\s*\d+ (s|min)/],
      subject: "iPhone 16 on worker-a",
      item: {
        condition: "stalled",
        device: inboxDevice({
          id: "dev_s",
          stalled: true,
          state: "provisioning",
          stateEnteredAt: NOW - 30_000,
          workerId: "wrk_a",
          workerLabel: "worker-a",
        }),
        group: "Needs a look",
        key: "dev_s/stalled",
      } satisfies InboxItem,
    },
    {
      condition: "over RAM budget",
      expected: [/Used\s*9\.00 GiB/, /Limit\s*8\.00 GiB/],
      subject: "worker-a",
      item: {
        condition: "over RAM budget",
        group: "Needs a look",
        key: "wrk_a/over RAM budget",
        limitBytes: 8 * 2 ** 30,
        usedBytes: 9 * 2 ** 30,
        worker: inboxWorker({ id: "wrk_a", label: "worker-a" }),
      } satisfies InboxItem,
    },
  ])("opens the $condition item's drawer with its facts", async (scenario) => {
    const { user } = renderConsole({
      path: "/inbox",
      routes: { "/v1/inbox": { body: { items: [scenario.item] } } },
    });

    await screen.findAllByRole("link");
    await user.click(item(scenario.condition, scenario.subject) as HTMLElement);

    for (const fact of scenario.expected) expect(facts()).toHaveTextContent(fact);
  });
});
