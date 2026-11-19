import { act } from "@testing-library/react";

// why: the console reads each route on its own interval and again when the operator comes back to
// the tab, so a test that changes what the daemon answers and wants the page to show it at once
// hides the tab and shows it again, which is that return.
export async function returnToTab(): Promise<void> {
  const show = async (state: "hidden" | "visible") => {
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };
  await show("hidden");
  await show("visible");
}
