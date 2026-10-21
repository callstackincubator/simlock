import type { Page } from "@playwright/test";

import { waitFor } from "../helpers/wait.js";
import {
  disposeFleet,
  expect,
  type RunningDaemon,
  signIn,
  startDaemon,
  startFleet,
  test,
} from "./fixtures.js";

const ONE_DEVICE = { limits: { ios: { maxDevices: 1, maxRunning: 1 }, maxRunning: 1 } };
const IOS = { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] };

async function readJson<T>(daemon: RunningDaemon, path: string): Promise<T> {
  const response = await fetch(new URL(path, daemon.url), {
    headers: { Authorization: `Bearer ${daemon.tokens.operator}` },
  });
  return (await response.json()) as T;
}

// why: a host with one device held by `nav-holder` and one request, `nav-waiter`, waiting behind it.
async function startHostWithQueue(): Promise<RunningDaemon> {
  const host = await startDaemon("worker", { config: ONE_DEVICE, driverScript: { ios: IOS } });
  const args = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "18.4"];
  const granted = await host.cli([...args, "--detach", "--agent-id", "nav-holder"]);
  expect(granted.code, granted.stderr).toBe(0);
  host.cliBackground([...args, "--agent-id", "nav-waiter"]);
  await waitFor(
    async () =>
      (await readJson<{ requests: unknown[] }>(host, "/v1/lease-requests")).requests.length === 1,
    { label: "the daemon lists the waiting request" },
  );
  return host;
}

async function openConsole(page: Page, token: string, path = "/"): Promise<void> {
  await page.goto(path);
  await signIn(page, token);
  await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeVisible();
}

test.describe("the search box", () => {
  test("⌘K and Ctrl+K open the dialog and focus the box, the sidebar button opens it too, and Escape closes it and returns focus", async ({
    daemon,
    page,
  }) => {
    await openConsole(page, daemon.tokens.operator);
    const dialog = page.getByRole("dialog", { name: "Search" });
    const box = dialog.getByRole("combobox", { name: "Search pages, items and actions" });

    for (const shortcut of ["Meta+k", "Control+k"]) {
      await page.keyboard.press(shortcut);
      await expect(dialog).toBeVisible();
      await expect(box).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    const button = page.getByRole("button", { name: "Search or jump to…" });
    await button.click();
    await expect(dialog).toBeVisible();
    await expect(box).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
  });
});

test.describe("the search results", () => {
  test("a typed name and Enter go to its page, worker, device, lease or request", async ({
    page,
  }) => {
    const host = await startHostWithQueue();
    try {
      const [worker] = (
        await readJson<{ workers: { id: string; label?: string }[] }>(host, "/v1/workers")
      ).workers as [{ id: string; label?: string }];
      const [lease] = (
        await readJson<{ leases: { id: string; deviceId: string }[] }>(host, "/v1/leases")
      ).leases as [{ id: string; deviceId: string }];
      const [request] = (await readJson<{ requests: { id: string }[] }>(host, "/v1/lease-requests"))
        .requests as [{ id: string }];
      await openConsole(page, host.tokens.operator, new URL("/", host.url).toString());
      const box = page.getByRole("combobox", { name: "Search pages, items and actions" });
      const goTo = async (typed: string, path: RegExp) => {
        await page.keyboard.press("Control+k");
        await box.fill(typed);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
        await expect(page).toHaveURL(path);
      };
      const encoded = (id: string) => encodeURIComponent(id).replaceAll(".", "\\.");

      await goTo("fleet", /\/fleet$/);
      await goTo(worker.label ?? worker.id, new RegExp(`/fleet/${encoded(worker.id)}$`));
      await goTo("iphone", new RegExp(`/fleet/${encoded(worker.id)}/${encoded(lease.deviceId)}$`));
      await goTo("nav-holder", new RegExp(`/leases/${encoded(lease.id)}/?$`));
      await goTo("nav-waiter", new RegExp(`/queue/${encoded(request.id)}$`));
    } finally {
      await host.dispose();
    }
  });
});

test.describe("the search actions", () => {
  test("an action runs as from its menu: drain with its toast and Undo, release and cancel after their confirms, remove after the name is typed", async ({
    page,
  }) => {
    const fleet = await startFleet([
      { driverScript: { ios: IOS }, label: "gone-a" },
      { driverScript: { ios: IOS }, label: "live-b" },
    ]);
    const host = await startHostWithQueue();
    try {
      const [stopped] = fleet.workers as [RunningDaemon];
      await stopped.stop();
      await waitFor(
        async () =>
          (
            await readJson<{ workers: { connection: string }[] }>(fleet.gateway, "/v1/workers")
          ).workers.some((view) => view.connection === "disconnected"),
        { label: "the gateway sees the stopped worker disconnected" },
      );
      const run = async (typed: string) => {
        await page.keyboard.press("Control+k");
        await page.getByRole("combobox", { name: "Search pages, items and actions" }).fill(typed);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
      };

      await openConsole(page, fleet.gateway.tokens.operator, fleet.gateway.url);
      await run("drain live-b");
      await expect(page.getByText("live-b drained", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("live-b takes leases again")).toBeVisible();

      await run("remove gone-a");
      const removal = page.getByRole("alertdialog", { name: "Remove gone-a?" });
      const remove = removal.getByRole("button", { name: "Remove worker" });
      await expect(remove).toBeDisabled();
      await removal.getByRole("textbox").fill("gone-");
      await expect(remove).toBeDisabled();
      await removal.getByRole("textbox").fill("gone-a");
      await expect(remove).toBeEnabled();
      await removal.getByRole("button", { name: "Keep" }).click();

      await page.goto(host.url);
      await signIn(page, host.tokens.operator);
      await expect(page.getByRole("button", { name: "Search or jump to…" })).toBeVisible();
      await run("release nav-holder");
      await expect(
        page.getByRole("alertdialog", { name: "Release nav-holder's lease?" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Keep" }).click();
      await run("cancel nav-waiter");
      await expect(
        page.getByRole("alertdialog", { name: "Cancel nav-waiter's request?" }),
      ).toBeVisible();
    } finally {
      await host.dispose();
      await disposeFleet(fleet);
    }
  });
});
