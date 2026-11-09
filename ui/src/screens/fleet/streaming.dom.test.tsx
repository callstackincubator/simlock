import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Answer, renderConsole, type Routes } from "../../test/console";
import { device, event, lease, NOW, worker } from "../../test/fixtures";

const STREAM = "/v1/stream/workers/wrk_1/devices/dev_1";
const PAGE = "/fleet/wrk_1/devices/dev_1/";
const CAPABLE = [{ name: "stream", state: "available" }] as never;

// why: a picture the worker has not started yet: the request is open and nothing has answered.
const PENDING = () => new Promise<Answer>(() => undefined);

function host(state: string, over: Parameters<typeof worker>[0] = {}) {
  return worker({
    capabilities: CAPABLE,
    devices: [device({ state: state as never })],
    ...over,
  });
}

const LEASED = host("leased", { leases: [lease()] });

const DETAILS = {
  lease: {
    createdAt: new Date(NOW - 3_600_000).toISOString(),
    device: "iPhone 16",
    deviceId: "dev_1",
    expiresAt: new Date(NOW + 600_000).toISOString(),
    id: "lse_1",
    udid: "UDID-1",
    workerId: "wrk_1",
  },
};

function routes(view: ReturnType<typeof host>, stream: Routes[string] = PENDING): Routes {
  return {
    [`GET ${STREAM}`]: stream,
    "/v1/leases": { body: { leases: view.leases ?? [] } },
    "/v1/leases/lse_1": { body: DETAILS },
    "/v1/workers": { body: { workers: [view] } },
  };
}

function picture() {
  return screen.queryByLabelText("The device's screen");
}

describe("the device's streaming page", () => {
  it("redirects a legacy ?drawer=screen address to the page and asks for the device's picture once, from the page", async () => {
    const { callsTo } = renderConsole({
      mode: "worker",
      path: "/fleet/wrk_1/dev_1?tab=devices&drawer=screen",
      routes: routes(LEASED),
    });

    await waitFor(() => expect(window.location.pathname).toBe(PAGE));
    expect(await screen.findByLabelText("The device's screen")).toBeVisible();
    await waitFor(() => expect(callsTo("GET", STREAM)).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the Holder card only while the device is leased, and keeps one picture request across the lease", async () => {
    let view = host("ready");
    const { callsTo, events } = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: {
        ...routes(view),
        "/v1/leases": () => ({ body: { leases: view.leases ?? [] } }),
        "/v1/workers": () => ({ body: { workers: [view] } }),
      },
    });
    expect(await screen.findByLabelText("The device's screen")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Holder" })).toBeNull();
    expect(screen.getByRole("region", { name: "Device" })).toBeVisible();

    view = host("leased", { leases: [lease({ requesterId: "console-screen" })] });
    events.push("lease.granted", event("lease.granted", { leaseId: "lse_1" }));

    const holder = await screen.findByRole("region", { name: "Holder" });
    expect(holder).toHaveTextContent("console-screen");
    expect(within(holder).getByRole("link", { name: "Lease details" })).toBeVisible();
    expect(within(holder).getByRole("button", { name: "Copy lease id" })).toBeVisible();
    expect(within(holder).getByRole("button", { name: "Release" })).toBeVisible();
    expect(picture()).not.toBeNull();
    expect(callsTo("GET", STREAM)).toHaveLength(1);
  });

  it("says why instead of asking for a picture of a device that is shut down", async () => {
    const { callsTo } = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: routes(host("shutdown")),
    });

    expect(
      await screen.findByText("The device is shut down. Its screen shows while it runs."),
    ).toBeVisible();
    expect(picture()).toBeNull();
    expect(callsTo("GET", STREAM)).toEqual([]);
  });

  it("starts the picture when the device runs, and closes it when the lease ends", async () => {
    let view = host("shutdown");
    const { callsTo, events } = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: {
        ...routes(view),
        "/v1/workers": () => ({ body: { workers: [view] } }),
      },
    });
    await screen.findByText("The device is shut down. Its screen shows while it runs.");

    view = host("leased", { leases: [lease({ requesterId: "console-screen" })] });
    events.push("lease.granted", event("lease.granted", { leaseId: "lse_1" }));

    expect(await screen.findByLabelText("The device's screen")).toBeVisible();
    await waitFor(() => expect(callsTo("GET", STREAM)).toHaveLength(1));
    const asked = callsTo("GET", STREAM)[0]?.signal;
    expect(asked?.aborted).toBe(false);

    view = worker({ capabilities: CAPABLE, devices: [] });
    events.push("lease.released", event("lease.released", { leaseId: "lse_1" }));

    await waitFor(() => expect(picture()).toBeNull());
    expect(asked?.aborted).toBe(true);
    expect(callsTo("GET", STREAM)).toHaveLength(1);
  });

  it("shows the daemon's words for a refused stream in the picture's place, a 409 and any other refusal alike", async () => {
    const refused = (status: number, code: string, message: string) => ({
      body: { error: { code, message } },
      status,
    });
    const first = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: routes(
        LEASED,
        refused(409, "DEVICE_NOT_RUNNING", "The row is behind: the device stopped just now."),
      ),
    });
    expect(
      await screen.findByText("The row is behind: the device stopped just now."),
    ).toBeVisible();
    expect(picture()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();

    renderConsole({
      mode: "worker",
      path: PAGE,
      routes: routes(
        LEASED,
        refused(500, "CAPTURE_FAILED", "The capture program could not start."),
      ),
    });
    expect(await screen.findByText("The capture program could not start.")).toBeVisible();
    expect(picture()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says streaming is off where it is, and asks for no picture", async () => {
    const { callsTo } = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: routes(host("leased", { capabilities: [], leases: [lease()] })),
    });

    expect(await screen.findByText(/^Streaming is off on /)).toBeVisible();
    expect(picture()).toBeNull();
    expect(callsTo("GET", STREAM)).toEqual([]);
  });
});

describe("the streaming page's holder actions", () => {
  const FAILURE = "Couldn't copy. Select and copy the id.";

  // why: user-event gives the page a clipboard of its own when a test sets it up, so the test's
  // clipboard replaces that one after the page is drawn.
  function setClipboard(clipboard: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  }

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  function notifications() {
    return within(screen.getByRole("region", { name: "Notifications" }));
  }

  async function holderCard(extra: Routes = {}) {
    const view = renderConsole({
      mode: "worker",
      path: PAGE,
      routes: { ...routes(LEASED), ...extra },
    });
    const holder = await screen.findByRole("region", { name: "Holder" });
    return { holder, view };
  }

  it("Copy lease id puts the complete lease id on the clipboard and says so", async () => {
    const { holder, view } = await holderCard();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });

    await view.user.click(within(holder).getByRole("button", { name: "Copy lease id" }));

    expect(await screen.findByText("Copied lease id")).toBeVisible();
    expect(writeText).toHaveBeenCalledWith("lse_1");
  });

  it.each([
    ["is absent", undefined],
    [
      "refuses access",
      { writeText: () => Promise.reject(new DOMException("no", "NotAllowedError")) },
    ],
  ])(
    "when the Clipboard API %s, Copy lease id says so, shows no success and keeps focus",
    async (_name, clipboard) => {
      const { holder, view } = await holderCard();
      setClipboard(clipboard);
      const copy = within(holder).getByRole("button", { name: "Copy lease id" });

      await view.user.click(copy);

      expect(await notifications().findByText(FAILURE)).toBeVisible();
      expect(screen.queryByText("Copied lease id")).not.toBeInTheDocument();
      expect(copy).toHaveFocus();
    },
  );

  it("when the Clipboard API never answers, Copy lease id gives up after 5 seconds, keeps focus, and a late success shows nothing", async () => {
    let finishCopy: () => void = () => undefined;
    const { holder } = await holderCard();
    setClipboard({
      writeText: () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    });
    const copy = within(holder).getByRole("button", { name: "Copy lease id" });
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });

    copy.focus();
    fireEvent.click(copy);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(screen.queryByText(FAILURE)).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(200);

    expect(notifications().getByText(FAILURE)).toBeVisible();
    expect(copy).toHaveFocus();
    finishCopy();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText("Copied lease id")).not.toBeInTheDocument();
  });

  it("Release asks first: Keep sends nothing, Release lease releases it, and a refusal says the daemon's words", async () => {
    let answer: Answer = { body: {} };
    const { holder, view } = await holderCard({ "DELETE /v1/leases/*": () => answer });
    const dialogTitle = "Release console's lease?";
    const holderName = within(holder).getByText(/^console|agent/, {
      selector: ".stream-holder-name",
    });
    const name = holderName.textContent ?? "";
    const title = `Release ${name}'s lease?`;
    void dialogTitle;

    await view.user.click(within(holder).getByRole("button", { name: "Release" }));
    const asked = await screen.findByRole("alertdialog", { name: title });
    await view.user.click(within(asked).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: title })).toBeNull());
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(0);

    answer = {
      body: { error: { code: "LEASE_BUSY", message: "The lease is being renewed." } },
      status: 409,
    };
    await view.user.click(within(holder).getByRole("button", { name: "Release" }));
    await view.user.click(
      within(await screen.findByRole("alertdialog", { name: title })).getByRole("button", {
        name: "Release lease",
      }),
    );
    expect(await notifications().findByText(`Couldn't release ${name}'s lease`)).toBeVisible();
    expect(notifications().getByText("The lease is being renewed.")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);

    answer = { body: {} };
    await view.user.click(within(holder).getByRole("button", { name: "Release" }));
    await view.user.click(
      within(await screen.findByRole("alertdialog", { name: title })).getByRole("button", {
        name: "Release lease",
      }),
    );
    expect(await notifications().findByText(`Released ${name}'s lease`)).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(2);
  });
});
