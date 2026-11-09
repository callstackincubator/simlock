import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { InboxItem } from "../model/inbox";
import { renderConsole } from "../test/console";
import { event, inboxLease, inboxWorker, NOW, request } from "../test/fixtures";

const PAGES = ["Overview", "Inbox", "Fleet", "Leases", "Queue", "Baselines", "Activity", "Usage"];

function incompatible(id: string): InboxItem {
  return {
    condition: "incompatible",
    group: "Broken",
    key: `${id}/incompatible`,
    worker: inboxWorker({ connection: "incompatible", id, label: id }),
  };
}

describe("the sidebar's Inbox count", () => {
  it("equals the problem items on every page and is hidden at 0", async () => {
    // why: a request that has waited two minutes is a problem item and counts; a lease about to end
    // is a heads-up and does not.
    let workers: InboxItem[] = [incompatible("old-1"), incompatible("old-2")];
    let waiters: InboxItem[] = [
      {
        condition: "waiting",
        group: "Needs a look",
        key: "request/long-waiter/waiting",
        request: request({
          createdAt: NOW - 125_000,
          id: "long-waiter",
          requesterId: "long-waiter",
        }),
      },
    ];
    const soon: InboxItem = {
      condition: "ending",
      group: "Heads-up",
      key: "lease/lease-soon/ending",
      lease: inboxLease({ id: "lease-soon", ttlDeadline: NOW + 60_000 }),
    };
    const { events, user } = renderConsole({
      routes: { "/v1/inbox": () => ({ body: { items: [...workers, ...waiters, soon] } }) },
    });

    const nav = await screen.findByRole("navigation", { name: "Console" });
    await within(nav).findByRole("link", { name: "Inbox 3 items" });
    const inboxLink = () => within(nav).getByRole("link", { name: /^Inbox/ });
    for (const label of PAGES) {
      await user.click(within(nav).getByRole("link", { name: new RegExp(`^${label}`) }));
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeVisible();
      expect(inboxLink()).toHaveAccessibleName("Inbox 3 items");
    }

    workers = [incompatible("old-2")];
    events.push("worker.removed", event("worker.removed", { workerId: "old-1" }));
    await waitFor(() => expect(inboxLink()).toHaveAccessibleName("Inbox 2 items"));

    waiters = [];
    events.push("queue.changed", event("queue.changed"));
    await waitFor(() => expect(inboxLink()).toHaveAccessibleName("Inbox 1 item"));

    workers = [];
    events.push("worker.removed", event("worker.removed", { workerId: "old-2" }));
    await waitFor(() => expect(inboxLink()).toHaveAccessibleName("Inbox"));
  });
});
