import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type Answer, type Routes, renderConsole } from "../test/console";
import { device, lease, NOW, request, worker, workerItem } from "../test/fixtures";

const PHONE = device({ id: "dev_1" });
const HOST = worker({ devices: [PHONE], id: "wrk_1", label: "mac-studio-01" });

function leaseDetail(id: string) {
  return {
    lease: {
      createdAt: new Date(NOW - 3_600_000).toISOString(),
      device: "iPhone 16",
      deviceId: "dev_1",
      expiresAt: new Date(NOW + 600_000).toISOString(),
      id,
      udid: "UDID-1",
    },
  };
}

// why: the daemon holds its leases until a release arrives; the test answers the release the way
// the daemon does, then announces it on the event stream like the daemon.
function leaseRoutes(holders: readonly string[], onDelete?: () => Answer | Promise<Answer>) {
  const held = new Map(holders.map((holder, i) => [`lse_${String(i + 1)}`, holder]));
  const routes: Routes = {
    "/v1/leases": () => ({
      body: {
        leases: [...held].map(([id, requesterId]) => lease({ id, requesterId })),
      },
    }),
    "/v1/leases/*": (call) => {
      const id = call.path.split("/").at(-1) ?? "";
      return held.has(id)
        ? { body: leaseDetail(id) }
        : { body: { error: { code: "UNKNOWN_LEASE", message: "No such lease" } }, status: 404 };
    },
    "/v1/workers": { body: { workers: [HOST] } },
    "DELETE /v1/leases/*": async (call) => {
      const answer = (await onDelete?.()) ?? {};
      if ((answer.status ?? 200) < 400) held.delete(call.path.split("/").at(-1) ?? "");
      return { body: {}, ...answer };
    },
  };
  return { held, routes };
}

// why: an error toast is also an alertdialog, so a confirmation is told apart by its title.
function dialogNamed(name: string): HTMLElement | null {
  return screen.queryByRole("alertdialog", { name });
}

const WORKER_ACTION = /^(Drain|Undrain|Remove)/;

async function openLease(
  console: ReturnType<typeof renderConsole>,
  holder: string,
): Promise<HTMLElement> {
  await console.user.click(await screen.findByRole("link", { name: holder }));
  const pane = await screen.findByRole("region", { name: "Lease" });
  await within(pane).findByRole("button", { name: "Release" });
  return pane;
}

describe("the console acts", () => {
  it.each(["worker", "gateway"] as const)(
    "a lease is released from the lease inspector on a %s after a dialog, a toast follows, and the row has no menu",
    async (mode) => {
      const { held, routes } = leaseRoutes(["release-agent"]);
      const view = renderConsole({ mode, path: "/leases", routes });
      const pane = await openLease(view, "release-agent");
      expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
      await view.user.click(within(pane).getByRole("button", { name: "Release" }));
      const dialog = await screen.findByRole("alertdialog", {
        name: "Release release-agent's lease?",
      });
      expect(dialog).toHaveTextContent(
        "iPhone 16 on mac-studio-01 goes back to the pool now, and release-agent's next command on it fails.",
      );

      await view.user.click(within(dialog).getByRole("button", { name: "Keep" }));
      await waitFor(() => expect(dialogNamed("Release release-agent's lease?")).toBeNull());
      expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(0);
      expect([...held.values()]).toEqual(["release-agent"]);

      await view.user.click(within(pane).getByRole("button", { name: "Release" }));
      await view.user.click(
        within(
          await screen.findByRole("alertdialog", { name: "Release release-agent's lease?" }),
        ).getByRole("button", { name: "Release lease" }),
      );
      expect(await screen.findByText("Released release-agent's lease")).toBeVisible();
      expect(screen.getByText("iPhone 16 on mac-studio-01 goes back to the pool.")).toBeVisible();
      expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);
      expect(held.size).toBe(0);
      view.events.push("lease.released", {
        event: "lease.released",
        id: "evt_r",
        payload: { leaseId: "lse_1" },
        seq: 1,
        timestamp: NOW,
      });
      expect(await screen.findByText("This lease is not held.")).toBeVisible();
      expect(screen.queryByRole("link", { name: "release-agent" })).not.toBeInTheDocument();

      await view.user.click(screen.getByRole("button", { name: "View device" }));
      expect(window.location.pathname).toBe("/fleet/wrk_1/dev_1");
      expect(await screen.findByRole("dialog", { name: /iPhone 16/ })).toBeVisible();
    },
  );

  it("a waiting request is cancelled from the Queue's menu after a dialog, and leaves the list", async () => {
    let waiting = [request({ id: "req_1", requesterId: "waiter", spec: waiterSpec() })];
    const view = renderConsole({
      path: "/queue",
      routes: {
        "/v1/lease-requests": () => ({ body: { requests: waiting } }),
        "DELETE /v1/lease-requests/*": () => {
          waiting = [];
          return { body: {} };
        },
      },
    });
    const menu = await screen.findByRole("button", { name: "Actions for waiter" });

    await view.user.click(menu);
    await view.user.click(screen.getByRole("menuitem", { name: "Cancel request" }));
    const dialog = screen.getByRole("alertdialog", { name: "Cancel waiter's request?" });
    expect(dialog).toHaveTextContent(
      "waiter stops waiting for iOS iPhone 16, runtime 18.4 and gets an error.",
    );
    await view.user.click(within(dialog).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(dialogNamed("Cancel waiter's request?")).toBeNull());
    expect(view.callsTo("DELETE", "/v1/lease-requests/req_1")).toHaveLength(0);

    await view.user.click(menu);
    await view.user.click(screen.getByRole("menuitem", { name: "Cancel request" }));
    await view.user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Cancel waiter's request?" }),
      ).getByRole("button", { name: "Cancel request" }),
    );
    expect(await screen.findByText("Cancelled waiter's request")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/lease-requests/req_1")).toHaveLength(1);
    view.events.push("queue.changed", {
      event: "queue.changed",
      id: "evt_q",
      payload: {},
      seq: 1,
      timestamp: NOW,
    });
    expect(await screen.findByText("No requests are waiting.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Actions for waiter" })).not.toBeInTheDocument();
  });

  it("the Inbox's fix button undrains a drained worker, and the item leaves the Inbox", async () => {
    let drained = true;
    const view = renderConsole({
      path: "/inbox",
      routes: {
        "/v1/inbox": () => ({
          body: {
            items: drained
              ? [workerItem("drained", "Needs a look", worker({ drained, label: "inbox-a" }))]
              : [],
          },
        }),
        "DELETE /v1/workers/*/drain": () => {
          drained = false;
          return { body: {} };
        },
      },
    });
    const item = (await screen.findByText("inbox-a")).closest("li") as HTMLElement;

    await view.user.click(within(item).getByRole("button", { name: "Undrain" }));
    expect(await screen.findByText("inbox-a takes leases again")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/workers/wrk_1/drain")).toHaveLength(1);
    view.events.push("worker.updated", {
      event: "worker.updated",
      id: "evt_w",
      payload: {},
      seq: 1,
      timestamp: NOW,
    });
    expect(await screen.findByText("Nothing needs you.")).toBeVisible();
    expect(item).not.toBeInTheDocument();
  });

  it("a refused action shows an error toast with the daemon's message and Retry, which sends again, while the dialog stays open as the row leaves", async () => {
    const { held, routes } = leaseRoutes(["refused-agent"], () => ({
      body: { error: { code: "UNKNOWN_LEASE", message: "No lease lse_1 is held." } },
      status: 404,
    }));
    const view = renderConsole({ path: "/leases", routes });
    const pane = await openLease(view, "refused-agent");
    await view.user.click(within(pane).getByRole("button", { name: "Release" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Release refused-agent's lease?",
    });

    held.clear();
    view.events.push("lease.released", {
      event: "lease.released",
      id: "evt_r",
      payload: { leaseId: "lse_1" },
      seq: 1,
      timestamp: NOW,
    });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "refused-agent" })).not.toBeInTheDocument(),
    );
    expect(dialog).toBeVisible();

    await view.user.click(within(dialog).getByRole("button", { name: "Release lease" }));
    const toasts = within(await screen.findByRole("region", { name: "Notifications" }));
    expect(await toasts.findByText("Couldn't release refused-agent's lease")).toBeVisible();
    expect(toasts.getByText("No lease lse_1 is held.")).toBeVisible();
    await waitFor(() => expect(dialogNamed("Release refused-agent's lease?")).toBeNull());
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);

    await view.user.click(toasts.getByText("Retry", { exact: true }));
    await waitFor(() => expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(2));
    expect(await toasts.findByText("Couldn't release refused-agent's lease")).toBeVisible();
  });

  it("a write that gets no answer shows The daemon did not answer. and the operator stays signed in", async () => {
    const { routes } = leaseRoutes(["silent-agent"]);
    const view = renderConsole({
      path: "/leases",
      routes: {
        ...routes,
        "DELETE /v1/leases/*": () => {
          throw new TypeError("Failed to fetch");
        },
      },
    });
    const pane = await openLease(view, "silent-agent");
    await view.user.click(within(pane).getByRole("button", { name: "Release" }));
    await view.user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Release silent-agent's lease?" }),
      ).getByRole("button", { name: "Release lease" }),
    );

    const toasts = within(await screen.findByRole("region", { name: "Notifications" }));
    expect(await toasts.findByText("Couldn't release silent-agent's lease")).toBeVisible();
    expect(toasts.getByText("The daemon did not answer.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "silent-agent" })).toBeVisible();
  });

  it("a write the daemon answers with 401 shows no error toast and signs the operator out", async () => {
    const { routes } = leaseRoutes(["expired-agent"], () => ({
      body: { error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" } },
      status: 401,
    }));
    const view = renderConsole({ path: "/leases", routes });
    const pane = await openLease(view, "expired-agent");
    await view.user.click(within(pane).getByRole("button", { name: "Release" }));
    await view.user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Release expired-agent's lease?" }),
      ).getByRole("button", { name: "Release lease" }),
    );

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
    expect(screen.queryByText("Couldn't release expired-agent's lease")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("while a release is in flight its button reads Releasing… and is disabled, and a second click sends no second DELETE", async () => {
    let answer: () => void = () => undefined;
    const { routes } = leaseRoutes(
      ["slow-agent"],
      () =>
        new Promise((resolve) => {
          answer = () => resolve({});
        }),
    );
    const view = renderConsole({ path: "/leases", routes });
    const pane = await openLease(view, "slow-agent");
    await view.user.click(within(pane).getByRole("button", { name: "Release" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Release slow-agent's lease?" });
    await view.user.click(within(dialog).getByRole("button", { name: "Release lease" }));

    const busy = await within(dialog).findByRole("button", { name: "Releasing…" });
    expect(busy).toBeDisabled();
    await view.user.click(busy);
    await view.user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);

    answer();
    await waitFor(() => expect(dialogNamed("Release slow-agent's lease?")).toBeNull());
    expect(await screen.findByText("Released slow-agent's lease")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);
  });

  it("on a single host the lease inspector and Inbox offer no worker actions", async () => {
    const { routes } = leaseRoutes(["solo-agent"]);
    const drained = workerItem(
      "drained",
      "Needs a look",
      worker({ drained: true, id: "wrk_solo" }),
    );
    const view = renderConsole({
      mode: "worker",
      path: "/leases",
      routes: { ...routes, "/v1/inbox": { body: { items: [drained] } } },
    });
    const pane = await openLease(view, "solo-agent");
    expect(within(pane).getByRole("button", { name: "Release" })).toBeVisible();
    expect(within(pane).queryByRole("button", { name: WORKER_ACTION })).not.toBeInTheDocument();

    await view.user.click(screen.getByRole("link", { name: /^Inbox/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    expect(await screen.findByRole("link", { name: /mac-studio-01/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: WORKER_ACTION })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
  });
});

function waiterSpec() {
  return { model: "iPhone 16", osVersion: "18.4", platform: "ios" } as const;
}
