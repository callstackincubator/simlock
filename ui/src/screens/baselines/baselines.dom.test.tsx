import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderConsole } from "../../test/console";
import { baseline, device, event, lease, NOW, worker } from "../../test/fixtures";

const MIB = 2 ** 20;

function rows() {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

function rowOf(name: string): HTMLElement {
  const found = rows().find((row) => within(row).queryByText(name) !== null);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

const REASON = "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed";

describe("the Baselines page", () => {
  it("lists each baseline the worker holds in a platform group, a save shows its row with no reload", async () => {
    let baselines: ReturnType<typeof baseline>[] = [];
    const { events } = renderConsole({
      mode: "worker",
      path: "/baselines",
      routes: {
        "/v1/baselines": () => ({ body: { baselines } }),
        "/v1/workers": { body: { workers: [worker()] } },
      },
    });
    expect(await screen.findByText("No baselines.")).toBeVisible();

    baselines = [
      baseline({ name: "checkout", savedAt: new Date(NOW - 5_000).toISOString(), sizeBytes: MIB }),
    ];
    events.push("baseline.saved", event("baseline.saved", { name: "checkout" }));

    await waitFor(() => expect(rows()).toHaveLength(2));
    const checkout = rowOf("checkout");
    expect(checkout).toHaveTextContent("iPhone 16 · iOS 18.4");
    expect(checkout).toHaveTextContent("1 MiB");
    expect(checkout).toHaveTextContent("ago");
    expect(checkout).toHaveTextContent("ready");
    expect(screen.getByRole("cell", { name: /^iOS · 1 baseline$/ })).toBeVisible();
  });

  it("a second save keeps one row", async () => {
    let baselines = [baseline({ name: "checkout", sizeBytes: MIB, version: 1 })];
    const { events } = renderConsole({
      mode: "worker",
      path: "/baselines",
      routes: {
        "/v1/baselines": () => ({ body: { baselines } }),
        "/v1/workers": { body: { workers: [worker()] } },
      },
    });
    await waitFor(() => expect(rowOf("checkout")).toHaveTextContent("1 MiB"));

    baselines = [baseline({ name: "checkout", sizeBytes: 2 * MIB, version: 2 })];
    events.push("baseline.saved", event("baseline.saved", { name: "checkout" }));

    await waitFor(() => expect(rowOf("checkout")).toHaveTextContent("2 MiB"));
    expect(rows()).toHaveLength(2);
  });

  it("a lease naming the baseline shows it in the device's drawer", async () => {
    const copy = device({
      id: "dev_1",
      spec: {
        baseline: { name: "checkout", version: 2 },
        model: "iPhone 16",
        osVersion: "18.4",
        physical: false,
        platform: "ios",
      },
      state: "leased",
    });
    const plain = device({ id: "dev_2", state: "leased" });
    const host = worker({
      devices: [copy, plain],
      leases: [lease({ id: "lse_1" }), lease({ deviceId: "dev_2", id: "lse_2" })],
    });
    const routes = { "/v1/workers": { body: { workers: [host] } } };

    const first = renderConsole({ mode: "worker", path: "/fleet/wrk_1/dev_1?tab=devices", routes });
    const drawer = await screen.findByRole("dialog");
    expect(await within(drawer).findByText("Baseline")).toBeVisible();
    expect(within(drawer).getByText("checkout v2")).toBeVisible();
    first.unmount();

    renderConsole({ mode: "worker", path: "/fleet/wrk_1/dev_2?tab=devices", routes });
    const other = await screen.findByRole("dialog");
    expect(await within(other).findByText("Runtime")).toBeVisible();
    expect(within(other).queryByText("Baseline")).toBeNull();
  });

  it("a removal takes the row away with no reload", async () => {
    let baselines = [baseline({ name: "checkout" })];
    const { events } = renderConsole({
      mode: "worker",
      path: "/baselines",
      routes: {
        "/v1/baselines": () => ({ body: { baselines } }),
        "/v1/workers": { body: { workers: [worker()] } },
      },
    });
    await waitFor(() => expect(rows()).toHaveLength(2));

    baselines = [];
    events.push("baseline.removed", event("baseline.removed", { name: "checkout" }));

    expect(await screen.findByText("No baselines.")).toBeVisible();
  });

  it("on a gateway, the Worker column names each worker's baseline and a relayed save shows its row", async () => {
    let baselines = [baseline({ name: "alpha", workerId: "wrk_a" })];
    const { events } = renderConsole({
      path: "/baselines",
      routes: {
        "/v1/baselines": () => ({ body: { baselines } }),
        "/v1/workers": {
          body: {
            workers: [
              worker({ id: "wrk_a", label: "worker-a" }),
              worker({ id: "wrk_b", label: "worker-b" }),
            ],
          },
        },
      },
    });

    expect(await screen.findByRole("columnheader", { name: "Worker" })).toBeVisible();
    await waitFor(() => expect(rowOf("alpha")).toHaveTextContent("worker-a"));

    baselines = [...baselines, baseline({ name: "beta", workerId: "wrk_b" })];
    events.push("baseline.saved", event("baseline.saved", { name: "beta" }));

    await waitFor(() => expect(rowOf("beta")).toHaveTextContent("worker-b"));
    expect(rows()).toHaveLength(3);
  });

  it("a stale baseline shows its reason word for word on hover, an entry with no size shows a dash, filters and search narrow the groups, and 26 entries page at 25", async () => {
    const entries = Array.from({ length: 26 }, (_, index) => {
      const name = `base-${String(index).padStart(2, "0")}`;
      if (index > 0) return baseline({ name, sizeBytes: MIB });
      const { sizeBytes: _size, ...unsized } = baseline({ name, staleReason: REASON });
      return unsized;
    });
    const { calls, user } = renderConsole({
      mode: "worker",
      path: "/baselines",
      routes: {
        "/v1/baselines": { body: { baselines: entries } },
        "/v1/workers": { body: { workers: [worker()] } },
      },
    });

    await waitFor(() => expect(rows()).toHaveLength(26));
    expect(screen.queryByText("base-25")).toBeNull();
    const stale = rowOf("base-00");
    expect(within(stale).getByText("stale")).toBeVisible();
    expect(stale).not.toHaveTextContent(REASON);
    await user.hover(within(stale).getByText("stale"));
    expect(await screen.findByText(REASON)).toBeVisible();
    await user.unhover(within(stale).getByText("stale"));
    expect(stale).toHaveTextContent("—");
    expect(screen.getByRole("cell", { name: /^iOS · 26 baselines$/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("base-25")).toBeVisible();

    await user.click(screen.getByLabelText("Stale", { exact: true }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole("cell", { name: /^iOS · 1 baseline$/ })).toBeVisible();
    await user.click(screen.getByLabelText("Ready", { exact: true }));
    await user.type(screen.getByRole("searchbox", { name: "Search baselines" }), "base-07");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowOf("base-07")).toBeVisible();
    await user.clear(screen.getByRole("searchbox", { name: "Search baselines" }));
    await user.type(screen.getByRole("searchbox", { name: "Search baselines" }), "zzz");
    expect(await screen.findByText("No baselines match this filter or search.")).toBeVisible();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("Prepare baseline is a link to the documentation, and no Building filter or row menu is shown", async () => {
    const { calls } = renderConsole({
      mode: "worker",
      path: "/baselines",
      routes: {
        "/v1/baselines": { body: { baselines: [baseline()] } },
        "/v1/workers": { body: { workers: [worker()] } },
      },
    });

    const link = await screen.findByRole("link", { name: "Prepare baseline" });
    expect(link).toHaveAttribute(
      "href",
      "https://callstackincubator.github.io/simlock/docs/worker/baselines",
    );
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByLabelText("Building")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Actions for/ })).toHaveLength(0);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
