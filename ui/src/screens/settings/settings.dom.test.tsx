import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderConsole, resizeWindow } from "../../test/console";

afterEach(() => {
  resizeWindow(1280, 720);
});

function choices(legend: string) {
  return within(screen.getByRole("group", { name: legend }));
}

describe("Settings", () => {
  it("on a phone shows the stored desktop sidebar choice and saves the one picked", async () => {
    resizeWindow(390, 800);
    window.localStorage.setItem("simlock.sidebar", "narrow");
    const { user } = renderConsole({ path: "/settings" });
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    expect(choices("Sidebar").getByRole("radio", { name: "Collapsed" })).toBeChecked();

    await user.click(choices("Sidebar").getByRole("radio", { name: "Expanded" }));
    expect(window.localStorage.getItem("simlock.sidebar")).toBe("wide");
    expect(choices("Sidebar").getByRole("radio", { name: "Expanded" })).toBeChecked();

    await user.click(choices("Sidebar").getByRole("radio", { name: "Collapsed" }));
    expect(window.localStorage.getItem("simlock.sidebar")).toBe("narrow");
  });
});
