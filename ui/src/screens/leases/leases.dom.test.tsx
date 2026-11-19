import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Routes, renderConsole } from "../../test/console";
import { device, event, lease, leaseDetails, NOW, token, worker } from "../../test/fixtures";
import { returnToTab } from "../../test/tab";

const HOST = worker({
  devices: [device({ id: "dev_1" }), device({ id: "dev_2" })],
  id: "wrk_host",
  label: "mac-studio-01",
});

function leasePane() {
  return screen.getByRole("region", { name: "Lease" });
}

function leaseSummary() {
  return screen.getByRole("region", { name: "Lease summary" });
}

function tableRow(name: RegExp | string) {
  return screen.getByRole("row", { name });
}

function fact(container: HTMLElement, label: string) {
  return within(container).getByText(label, { selector: "dt" }).nextElementSibling;
}

// why: a single host names no worker on its leases, so the page finds the host itself.
function hostWith(leases: ReturnType<typeof lease>[], extra: Routes = {}): Routes {
  return {
    "/v1/leases": { body: { leases } },
    "/v1/tokens": { body: { tokens: [token({ id: "tok_ci", label: "ci-runner-3" })] } },
    "/v1/workers": { body: { workers: [HOST] } },
    ...extra,
  };
}

function detailsOf(...answers: ReturnType<typeof leaseDetails>[]): Routes {
  return {
    "/v1/leases/*": ({ path }) => {
      const found = answers.find((answer) => path === `/v1/leases/${answer.id}`);
      return found === undefined
        ? { body: { error: { code: "UNKNOWN_LEASE", message: "No such lease" } }, status: 404 }
        : { body: { lease: found } };
    },
  };
}

describe("the leases page", () => {
  it("lists every lease the fleet holds with its holder, worker and time left, and a token's label stands for its id", async () => {
    const workerA = worker({
      devices: [device({ id: "dev_a" })],
      id: "wrk_a",
      label: "worker-a",
    });
    const workerB = worker({
      devices: [
        device({
          id: "dev_b",
          spec: { model: "iPhone 17", osVersion: "18.4", physical: false, platform: "ios" },
        }),
      ],
      id: "wrk_b",
      label: "worker-b",
    });
    const gatewayIssued = lease({
      deviceId: "dev_a",
      id: "wrk_a.lse_1",
      requesterId: "tok_ci",
      workerId: "wrk_a",
    });
    const socketTaken = lease({
      deviceId: "dev_b",
      id: "lse_2",
      requesterId: "console-e2e",
      workerId: "wrk_b",
    });
    const onWorker = lease({
      deviceId: "dev_a",
      id: "lse_3",
      requesterId: "local-agent",
      workerId: "wrk_a",
    });
    renderConsole({
      path: "/leases",
      routes: {
        "/v1/leases": { body: { leases: [gatewayIssued, socketTaken, onWorker] } },
        "/v1/tokens": { body: { tokens: [token({ id: "tok_ci", label: "ci-runner-3" })] } },
        "/v1/workers": { body: { workers: [workerA, workerB] } },
      },
    });

    expect(await screen.findByRole("link", { name: "ci-runner-3" })).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
    expect(leaseSummary()).toHaveTextContent("3 leases");
    for (const [holder, workerName] of [
      ["ci-runner-3", "worker-a"],
      ["console-e2e", "worker-b"],
      ["local-agent", "worker-a"],
    ]) {
      const row = tableRow(new RegExp(holder as string));
      expect(row).toHaveTextContent(workerName as string);
      expect(row).toHaveTextContent(/\d{2}:\d{2}/);
    }
    expect(tableRow(/ci-runner-3/)).not.toHaveTextContent("tok_ci");
  });

  it("a lease row opens its inspector beside the table at the lease's address", async () => {
    const { user } = renderConsole({
      path: "/leases",
      routes: {
        ...hostWith([
          lease({ id: "lse_first", requesterId: "agent-first" }),
          lease({ deviceId: "dev_2", id: "lse_second", requesterId: "agent-second" }),
        ]),
        ...detailsOf(leaseDetails({ id: "lse_first" })),
      },
    });
    expect(await screen.findByRole("link", { name: "agent-first" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Lease" })).not.toBeInTheDocument();
    expect(leaseSummary()).toBeVisible();
    expect(window.location.pathname).toBe("/leases");

    await user.click(tableRow(/agent-first/));

    expect(await within(leasePane()).findByText("lse_first")).toBeVisible();
    expect(leasePane()).toHaveTextContent("agent-first");
    expect(screen.queryByRole("region", { name: "Lease summary" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/leases/lse_first/");
    expect(fact(leasePane(), "Lease id")).toHaveTextContent("lse_first");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(tableRow(/agent-first/)).toHaveAttribute("aria-selected", "true");
  });

  it("loading /leases/<id> directly opens the inspector beside the table", async () => {
    renderConsole({
      path: "/leases/lse_direct/",
      routes: {
        ...hostWith([lease({ id: "lse_direct", requesterId: "agent-direct" })]),
        ...detailsOf(leaseDetails({ id: "lse_direct" })),
      },
    });

    expect(await within(leasePane()).findByText("agent-direct")).toBeVisible();
    expect(tableRow(/agent-direct/)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("loaded directly at a lease's address, the close button replaces the address with /leases, brings the summary back and puts focus on the heading", async () => {
    const { user } = renderConsole({
      path: "/leases/lse_direct/",
      routes: {
        ...hostWith([lease({ id: "lse_direct", requesterId: "agent-direct" })]),
        ...detailsOf(leaseDetails({ id: "lse_direct" })),
      },
    });
    await within(await screen.findByRole("region", { name: "Lease" })).findByText("agent-direct");
    const entries = window.history.length;

    await user.click(within(leasePane()).getByRole("button", { name: "Close lease" }));

    await waitFor(() => expect(leaseSummary()).toBeVisible());
    expect(screen.queryByRole("region", { name: "Lease" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/leases");
    expect(window.history.length).toBe(entries);
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "Leases" })).toHaveFocus(),
    );
  });

  it("opened from the table, closing the inspector steps back and puts focus on the lease's row", async () => {
    const { user } = renderConsole({
      path: "/leases",
      routes: {
        ...hostWith([lease({ id: "lse_back", requesterId: "agent-back" })]),
        ...detailsOf(leaseDetails({ id: "lse_back" })),
      },
    });
    await user.click(await screen.findByRole("row", { name: /agent-back/ }));
    await within(await screen.findByRole("region", { name: "Lease" })).findByText("lse_back");

    await user.click(within(leasePane()).getByRole("button", { name: "Close lease" }));

    expect(await screen.findByRole("region", { name: "Lease summary" })).toBeVisible();
    expect(window.location.pathname).toBe("/leases");
    await waitFor(() => expect(screen.getByRole("link", { name: "agent-back" })).toHaveFocus());
    // why: a step back leaves the lease's entry ahead of the page, so Forward reopens it.
    act(() => window.history.forward());
    expect(await screen.findByRole("region", { name: "Lease" })).toBeVisible();
  });

  it("the inspector lists the events that name the lease, and no tab", async () => {
    const { user } = renderConsole({
      path: "/leases",
      routes: {
        ...hostWith([
          lease({ id: "lse_events", requesterId: "agent-events" }),
          lease({ deviceId: "dev_2", id: "lse_other", requesterId: "agent-other" }),
        ]),
        ...detailsOf(leaseDetails({ id: "lse_events" })),
        "/v1/events": {
          body: {
            events: [
              event("lease.granted", { leaseId: "lse_events" }),
              event("lease.granted", { leaseId: "lse_other" }),
            ],
          },
        },
      },
    });

    await user.click(await screen.findByRole("row", { name: /agent-events/ }));

    const events = await within(leasePane()).findByRole("region", { name: "Recent events" });
    expect(await within(events).findAllByText("lease.granted")).toHaveLength(1);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });
});

describe("Copy id", () => {
  // why: user-event gives the page a clipboard of its own when a test sets it up, so the test's
  // clipboard replaces that one after the page is drawn.
  function setClipboard(clipboard: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  }

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function openedLease() {
    return renderConsole({
      path: "/leases/lse_copy/",
      routes: {
        ...hostWith([lease({ id: "lse_copy", requesterId: "agent-copy" })]),
        ...detailsOf(leaseDetails({ id: "lse_copy" })),
      },
    });
  }

  it("puts the complete lease id on the clipboard", async () => {
    const { user } = openedLease();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });

    await user.click(await screen.findByRole("button", { name: "Copy id" }));

    expect(await screen.findByText("Copied lease id")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith("lse_copy");
  });

  it.each([
    ["is absent", undefined],
    [
      "refuses access",
      { writeText: () => Promise.reject(new DOMException("no", "NotAllowedError")) },
    ],
  ])(
    "when the Clipboard API %s, Copy id says so, shows no success and keeps focus",
    async (_name, clipboard) => {
      const { user } = openedLease();
      setClipboard(clipboard);
      const copy = await screen.findByRole("button", { name: "Copy id" });

      await user.click(copy);

      expect(
        await within(screen.getByRole("region", { name: "Notifications" })).findByText(
          "Couldn't copy. Select and copy the id.",
        ),
      ).toBeVisible();
      expect(screen.queryByText("Copied lease id")).not.toBeInTheDocument();
      expect(copy).toHaveFocus();
      expect(fact(leasePane(), "Lease id")).toHaveTextContent("lse_copy");
    },
  );

  it("when the Clipboard API never answers, gives up after 5 seconds, and a late success shows nothing", async () => {
    let finishCopy: () => void = () => undefined;
    openedLease();
    setClipboard({
      writeText: () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    });
    const copy = await screen.findByRole("button", { name: "Copy id" });
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const failure = "Couldn't copy. Select and copy the id.";

    fireEvent.click(copy);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(screen.queryByText(failure)).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(200);

    expect(
      within(screen.getByRole("region", { name: "Notifications" })).getByText(failure),
    ).toBeVisible();
    finishCopy();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText("Copied lease id")).not.toBeInTheDocument();
  });
});

describe("the leases page, search and details", () => {
  it("the search sets ?q= without adding history entries, a lease opened from it keeps ?q=, and closing the inspector returns to the filtered table", async () => {
    const { user } = renderConsole({
      path: "/leases?page=2",
      routes: {
        ...hostWith([
          lease({ id: "lse_needle", requesterId: "agent-needle" }),
          lease({ deviceId: "dev_2", id: "lse_hay", requesterId: "agent-hay" }),
        ]),
        ...detailsOf(leaseDetails({ id: "lse_needle" })),
      },
    });
    await screen.findByRole("link", { name: "agent-needle" });
    const entries = window.history.length;

    await user.type(screen.getByRole("searchbox", { name: "Search leases" }), "NEEDLE");

    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(1 + 1));
    expect(window.location.search).toBe("?q=NEEDLE");
    expect(window.history.length).toBe(entries);

    await user.click(tableRow(/agent-needle/));
    await within(await screen.findByRole("region", { name: "Lease" })).findByText("lse_needle");
    expect(window.location.search).toBe("?q=NEEDLE");

    await user.click(within(leasePane()).getByRole("button", { name: "Close lease" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Lease" })).not.toBeInTheDocument(),
    );
    expect(window.location.search).toBe("?q=NEEDLE");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 1);
  });

  it("a lease opens to its details on a gateway, whose lease id holds a '.', and a worker's own lease opens too", async () => {
    const workerA = worker({
      devices: [device({ id: "dev_a" })],
      id: "wrk_a",
      label: "worker-a",
    });
    const workerB = worker({
      devices: [
        device({
          id: "dev_b",
          spec: { model: "iPhone 17", osVersion: "18.4", physical: false, platform: "ios" },
        }),
      ],
      id: "wrk_b",
      label: "worker-b",
    });
    const issued = lease({
      deviceId: "dev_a",
      id: "wrk_a.lse_1",
      ownerId: "tok_ci",
      requesterId: "tok_ci",
      workerId: "wrk_a",
    });
    const local = lease({
      deviceId: "dev_b",
      id: "lse_local",
      requesterId: "local-agent",
      workerId: "wrk_b",
    });
    const { user } = renderConsole({
      path: "/leases",
      routes: {
        "/v1/leases": { body: { leases: [issued, local] } },
        "/v1/tokens": { body: { tokens: [token({ id: "tok_ci", label: "ci-runner-3" })] } },
        "/v1/workers": { body: { workers: [workerA, workerB] } },
        ...detailsOf(
          leaseDetails({ deviceId: "dev_a", id: "wrk_a.lse_1", workerId: "wrk_a" }),
          leaseDetails({
            device: "iPhone 17",
            deviceId: "dev_b",
            id: "lse_local",
            workerId: "wrk_b",
          }),
        ),
      },
    });

    await user.click(await screen.findByRole("row", { name: /ci-runner-3/ }));

    await within(await screen.findByRole("region", { name: "Lease" })).findByText("wrk_a.lse_1");
    expect(leasePane()).toHaveTextContent("ci-runner-3");
    expect(fact(leasePane(), "Holder")).toHaveTextContent("tok_ci");
    expect(fact(leasePane(), "Worker")).toHaveTextContent("worker-a");
    expect(fact(leasePane(), "Device")).toHaveTextContent("iPhone 16");
    expect(fact(leasePane(), "Lease id")).toHaveTextContent("wrk_a.lse_1");
    expect(fact(leasePane(), "Granted")).toHaveTextContent(" ago · ");
    expect(within(leasePane()).getByRole("timer")).toHaveTextContent(/^(\d+:)?\d{2}:\d{2}$/);
    expect(window.location.pathname).toBe("/leases/wrk_a.lse_1/");

    await user.click(within(leasePane()).getByRole("button", { name: "Close lease" }));
    await user.click(await screen.findByRole("row", { name: /local-agent/ }));

    await within(await screen.findByRole("region", { name: "Lease" })).findByText("lse_local");
    expect(leasePane()).toHaveTextContent("local-agent");
    expect(fact(leasePane(), "Worker")).toHaveTextContent("worker-b");
    expect(fact(leasePane(), "Device id")).not.toHaveTextContent("—");
  });

  it("a lease opens to its details on a single host, named by the host itself", async () => {
    renderConsole({
      path: "/leases/lse_host/",
      routes: {
        ...hostWith([lease({ id: "lse_host", ownerId: "tok_ci", requesterId: "tok_ci" })]),
        ...detailsOf(leaseDetails({ id: "lse_host" })),
      },
    });

    await within(await screen.findByRole("region", { name: "Lease" })).findByText("lse_host");
    expect(leasePane()).toHaveTextContent("ci-runner-3");
    expect(fact(leasePane(), "Holder")).toHaveTextContent("tok_ci");
    expect(fact(leasePane(), "Worker")).toHaveTextContent("mac-studio-01");
    expect(fact(leasePane(), "Lease id")).toHaveTextContent("lse_host");
  });
});

describe("the leases page follows the daemon", () => {
  it("the filters narrow the list to the expiring leases or to one platform", async () => {
    const { user } = renderConsole({
      path: "/leases",
      routes: hostWith([
        lease({ id: "lse_soon", requesterId: "tok_ci", ttlDeadline: NOW + 120_000 }),
        lease({
          deviceId: "dev_2",
          id: "lse_later",
          requesterId: "nightly",
          ttlDeadline: NOW + 3_000_000,
        }),
      ]),
    });
    expect(await screen.findByRole("row", { name: /ci-runner-3/ })).toBeVisible();
    expect(tableRow(/nightly/)).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "Ending < 5 min" }));
    expect(tableRow(/ci-runner-3/)).toBeVisible();
    expect(screen.queryByRole("row", { name: /nightly/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "iOS" }));
    expect(await screen.findByRole("row", { name: /nightly/ })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "Android" }));
    expect(await screen.findByText("No leases match this filter or search.")).toBeVisible();
  });

  it("a released lease leaves the list without a reload", async () => {
    let held = [
      lease({ id: "lse_released", requesterId: "agent-1" }),
      lease({ deviceId: "dev_2", id: "lse_kept", requesterId: "agent-2" }),
    ];
    const { events } = renderConsole({
      path: "/leases",
      routes: { ...hostWith([]), "/v1/leases": () => ({ body: { leases: held } }) },
    });
    expect(await screen.findByRole("link", { name: "agent-1" })).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 2);

    held = held.filter((candidate) => candidate.id !== "lse_released");
    events.push("lease.released", event("lease.released", { leaseId: "lse_released" }));

    await waitFor(() => expect(screen.queryByRole("link", { name: "agent-1" })).toBeNull());
    expect(screen.getByRole("link", { name: "agent-2" })).toBeVisible();
  });

  it('a lease that ends while its inspector is open shows "This lease is not held."', async () => {
    let held = true;
    const { events, user } = renderConsole({
      path: "/leases",
      routes: {
        ...hostWith([]),
        "/v1/leases": () => ({
          body: { leases: held ? [lease({ id: "lse_1", requesterId: "agent-1" })] : [] },
        }),
        "/v1/leases/*": () =>
          held
            ? { body: { lease: leaseDetails({ id: "lse_1" }) } }
            : { body: { error: { code: "UNKNOWN_LEASE", message: "No such lease" } }, status: 404 },
      },
    });
    await user.click(await screen.findByRole("row", { name: /agent-1/ }));
    expect(
      await within(await screen.findByRole("region", { name: "Lease" })).findByText("lse_1"),
    ).toBeVisible();

    held = false;
    events.push("lease.released", event("lease.released", { leaseId: "lse_1" }));

    expect(await within(leasePane()).findByText("This lease is not held.")).toBeVisible();
    expect(within(leasePane()).queryByText("Lease id")).not.toBeInTheDocument();
    expect(within(leasePane()).getByRole("button", { name: "Close lease" })).toBeVisible();
  });

  it('an address naming a lease never held shows "This lease is not held." and the table says "No leases."', async () => {
    renderConsole({
      path: "/leases/lse_nobody/",
      routes: { ...hostWith([]), ...detailsOf() },
    });

    expect(await screen.findByText("This lease is not held.")).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("No leases.");
  });

  it("a renewed lease shows its new time left", async () => {
    let deadline = NOW + 120_000;
    renderConsole({
      path: "/leases",
      routes: {
        ...hostWith([]),
        "/v1/leases": () => ({
          body: {
            leases: [lease({ id: "lse_renewed", requesterId: "tok_ci", ttlDeadline: deadline })],
          },
        }),
      },
    });
    const expiry = async () =>
      (await screen.findByRole("row", { name: /ci-runner-3/ })).lastElementChild;
    expect(await expiry()).toHaveTextContent(/^expiring, 02:00$/);

    deadline = NOW + 3_000_000;
    await returnToTab();

    await waitFor(async () => expect(await expiry()).toHaveTextContent(/^50:00$/));
  });
});
