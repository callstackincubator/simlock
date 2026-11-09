import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type Answer, renderConsole } from "../../test/console";
import { NOW, worker } from "../../test/fixtures";

const UPDATE_ROUTE = "POST /v1/workers/*/update";

function fleetWith(fields: Parameters<typeof worker>[0], answers: readonly Answer[]) {
  let sent = 0;
  return renderConsole({
    daemon: { latestVersion: "0.4.0", version: "0.3.0" },
    path: "/fleet",
    routes: {
      [UPDATE_ROUTE]: () => answers[sent++] ?? { status: 500 },
      "/v1/workers": {
        body: {
          workers: [
            worker({ label: "upd-a", latestVersion: "0.4.0", version: "0.3.0", ...fields }),
          ],
        },
      },
    },
  });
}

describe("the console updates a worker", () => {
  it("Update… sends an empty body and the toast names the version", async () => {
    const { callsTo, user } = fleetWith({ lastUpdateFailure: null, update: null }, [
      {
        body: {
          started: true,
          update: { from: "0.3.0", leases: 0, stage: "waiting", to: "0.4.0" },
          upToDate: false,
          version: "0.3.0",
        },
        status: 202,
      },
    ]);

    expect(await screen.findByText("simlock 0.3.0 · 0.4.0 available")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Actions for upd-a" }));
    await user.click(screen.getByRole("menuitem", { name: "Update…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Update upd-a from 0.3.0 to 0.4.0?" });
    expect(dialog).toHaveTextContent(
      "It has no leases, so it installs at once. It restarts by itself.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Update" }));

    expect(await screen.findByText("Updating upd-a to 0.4.0")).toBeVisible();
    expect(callsTo("POST", "/v1/workers/wrk_1/update").map((call) => call.body)).toEqual([{}]);
  });

  it("Update now → Install now sends force, a 200 upToDate answer names the version, and a 409 shows its message", async () => {
    const { callsTo, user } = fleetWith(
      {
        lastUpdateFailure: null,
        update: {
          forced: false,
          from: "0.3.0",
          leases: 2,
          stage: "waiting",
          startedAt: NOW,
          to: "0.4.0",
        },
      },
      [
        { body: { started: false, update: null, upToDate: true, version: "0.4.0" }, status: 200 },
        {
          body: { error: { code: "CONFLICT", message: "Another update is running." } },
          status: 409,
        },
      ],
    );

    // why: the update's actions live on the worker's page, reached by the row's name.
    await user.click(await screen.findByRole("link", { name: "upd-a" }));
    for (const toast of ["upd-a already runs 0.4.0", "Another update is running."]) {
      await user.click(await screen.findByRole("button", { name: "Actions for upd-a" }));
      await user.click(screen.getByRole("menuitem", { name: "Update now" }));
      const dialog = screen.getByRole("alertdialog", { name: "Install 0.4.0 on upd-a now?" });
      expect(dialog).toHaveTextContent("Its 2 leases keep running through the restart.");
      await user.click(within(dialog).getByRole("button", { name: "Install now" }));
      expect(
        await within(screen.getByRole("region", { name: "Notifications" })).findByText(toast),
      ).toBeVisible();
    }

    expect(callsTo("POST", "/v1/workers/wrk_1/update").map((call) => call.body)).toEqual([
      { force: true },
      { force: true },
    ]);
  });
});
