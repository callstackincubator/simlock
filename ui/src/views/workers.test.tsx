import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { Loaded } from "../live/route-state";
import { DeviceTable } from "./worker-detail";
import type { WorkerView } from "./workers-model";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function worker(overrides: Partial<WorkerView> = {}): WorkerView {
  return {
    catalog: [],
    connection: "connected",
    devices: [],
    drained: false,
    id: "wrk_1",
    lastSeenAt: NOW,
    leases: [],
    ...overrides,
  };
}

/** The text a screen shows, without markup. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the workers views", () => {
  it("an unknown device state renders as its raw name", () => {
    const device = {
      id: "dev_1",
      mode: "full",
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      // A state a newer daemon may send, which this console has never heard of.
      state: "hibernating",
    } as unknown as WorkerView["devices"][number];

    const html = renderToStaticMarkup(
      <DeviceTable worker={worker({ devices: [device] })} now={NOW} />,
    );

    expect(text(html)).toContain("dev_1 hibernating");
    expect(html).toContain('class="status status-idle"');
  });

  it("each device shows how long it has been in its state, where the data says", () => {
    const leased = {
      id: "dev_leased",
      mode: "full",
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "leased",
    } as const;
    const provisioning = {
      ...leased,
      id: "dev_new",
      state: "provisioning",
      transitionAgeMs: 4_000,
    } as const;
    const ready = { ...leased, id: "dev_ready", state: "ready" } as const;
    const lease = {
      deviceId: "dev_leased",
      grantedAt: NOW - 125_000,
      id: "l_1",
      lastRenewedAt: NOW - 125_000,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: NOW + 60_000,
      ttlMs: 185_000,
    };
    // The worker answered 10 seconds ago, when the provisioning device was 4 seconds in.
    const view = worker({
      devices: [leased, provisioning, ready],
      lastSeenAt: NOW - 10_000,
      leases: [lease],
    });

    const shown = text(renderToStaticMarkup(<DeviceTable worker={view} now={NOW} />));

    expect(shown).toContain("dev_leased leased 2 min 5 s");
    expect(shown).toContain("dev_new provisioning 14 s");
    expect(shown).toContain("dev_ready ready —");
  });

  it('a 501 UNSUPPORTED_IN_WORKER_MODE shows "Not available on a single host"', () => {
    const render = (error: ApiError) =>
      renderToStaticMarkup(<Loaded state={{ error }}>{() => "the view"}</Loaded>);

    const unsupported = render(
      new ApiError(501, "UNSUPPORTED_IN_WORKER_MODE", "worker.drain is not supported"),
    );
    expect(text(unsupported)).toBe("Not available on a single host.");
    // Not shown as an error.
    expect(unsupported).not.toContain('role="alert"');

    // Any other refusal is an error, with the daemon's message.
    const failed = render(new ApiError(500, "INTERNAL", "Internal error"));
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toBe("Internal error");
  });

  it("a refusal after earlier answers shows above the data kept from them", () => {
    const html = renderToStaticMarkup(
      <Loaded state={{ data: "the view", error: new ApiError(500, "INTERNAL", "Internal error") }}>
        {(data) => data}
      </Loaded>,
    );

    expect(html).toContain('role="alert"');
    expect(text(html)).toBe("Internal error the view");
  });

  it("a disconnected worker shows no time for a device mid-provisioning", () => {
    const provisioning = {
      id: "dev_new",
      mode: "full",
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "provisioning",
      transitionAgeMs: 4_000,
    } as const;
    const render = (connection: WorkerView["connection"]) =>
      text(
        renderToStaticMarkup(
          <DeviceTable
            worker={worker({ connection, devices: [provisioning], lastSeenAt: NOW - 10_000 })}
            now={NOW}
          />,
        ),
      );

    expect(render("connected")).toContain("dev_new provisioning 14 s");
    expect(render("disconnected")).toContain("dev_new provisioning —");
  });
});
