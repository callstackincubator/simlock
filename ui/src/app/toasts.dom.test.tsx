import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Routes, renderConsole } from "../test/console";
import { worker } from "../test/fixtures";

const NAMES = ["toast-a", "toast-b", "toast-c", "toast-d"];

function fleet(drain: Routes[string]) {
  return renderConsole({
    path: "/fleet",
    routes: {
      "POST /v1/workers/*/drain": drain,
      "/v1/workers": {
        body: {
          workers: NAMES.map((label) => worker({ id: `wrk_${label}`, label })),
        },
      },
    },
  });
}

async function drain(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: "Drain" }));
  await user.pointer({ target: document.body });
  // why: the menu closes after its own short motion, and the next one cannot open before.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(500);
}

// why: a toast is a dialog, an alert dialog when it is an error.
function toasts(): HTMLElement[] {
  const region = within(screen.getByRole("region", { name: "Notifications" }));
  return [...region.queryAllByRole("dialog"), ...region.queryAllByRole("alertdialog")];
}

function toastOf(text: string): HTMLElement | undefined {
  return toasts().find((toast) => toast.textContent?.includes(text));
}

// why: a toast's timer is Base UI's, so the clock moves under it from here on; the page is loaded first, because its reads are answered in real time.
const CLOCK = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

describe("toasts", () => {
  // why: Testing Library waits on the real clock unless it sees Jest's name for the fake one; this
  // is vitest's clock under that name, set for these tests alone.
  beforeAll(() => {
    Object.assign(globalThis, { jest: { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) } });
  });
  afterAll(() => {
    Reflect.deleteProperty(globalThis, "jest");
  });

  it("a success toast leaves after 6 s and stays while hovered, an error toast stays until closed, and at most three show while a fourth hides the oldest until one closes", async () => {
    let refuse = true;
    fleet(() => {
      if (refuse) throw new TypeError("Failed to fetch");
      return { body: {} };
    });
    await screen.findByRole("link", { name: "toast-d" });
    vi.useFakeTimers({ toFake: [...CLOCK] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });

    await drain(user, "toast-b");
    await waitFor(() => expect(toastOf("Couldn't drain toast-b")).toBeDefined());
    const refused = toastOf("Couldn't drain toast-b")!;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refused).toBeVisible();
    await user.click(within(refused).getByRole("button", { name: "Close" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(toastOf("Couldn't drain toast-b")).toBeUndefined();

    refuse = false;
    await drain(user, "toast-a");
    await waitFor(() => expect(toastOf("toast-a drained")).toBeDefined());
    const drained = toastOf("toast-a drained")!;
    // why: the toast appeared during drain's click, so drain's own 500 ms already ran on its 6 s.
    await vi.advanceTimersByTimeAsync(5_000);
    // why: a closing toast stays in the document until its exit animation ends on the real clock,
    // so only the attribute says, every run, whether the 6 s have run out.
    expect(drained).not.toHaveAttribute("data-ending-style");
    expect(drained).toBeVisible();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(toastOf("toast-a drained")).toBeUndefined());

    await drain(user, "toast-a");
    await waitFor(() => expect(toastOf("toast-a drained")).toBeDefined());
    const hovered = toastOf("toast-a drained")!;
    await user.hover(hovered);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hovered).toBeVisible();
    await user.pointer({ target: document.body });
    await vi.advanceTimersByTimeAsync(6_500);
    await waitFor(() => expect(toastOf("toast-a drained")).toBeUndefined());

    for (const name of NAMES) await drain(user, name);
    await waitFor(() => expect(toastOf("toast-d drained")).toBeDefined());
    // why: a toast past the limit is hidden by the console's sheet, so it is not among those shown.
    expect(toasts()).toHaveLength(3);
    expect(toastOf("toast-a drained")).toBeUndefined();

    await user.click(within(toastOf("toast-d drained")!).getByRole("button", { name: "Close" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(toastOf("toast-a drained")).toBeVisible();
    expect(toasts()).toHaveLength(3);
  });

  it("an error toast's text is in the role=alert element and a success toast's in the aria-live=polite region", async () => {
    let refuse = true;
    const view = fleet(() => {
      if (refuse) throw new TypeError("Failed to fetch");
      return { body: {} };
    });

    await drain(view.user, "toast-a");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't drain toast-a");
    expect(alert).toHaveTextContent("The daemon did not answer.");

    refuse = false;
    await drain(view.user, "toast-a");
    await screen.findAllByText("toast-a drained");
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("toast-a drained");
  });
});
