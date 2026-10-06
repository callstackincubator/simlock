import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { Loaded } from "../live/route-state";
import { DeviceTable, WorkerDetail } from "./worker-detail";
import { BusiestWorkers } from "./workers";
import { WorkerFacts } from "./worker-facts";
import { attentionItems } from "./attention-model";
import { deviceOfLease } from "./leases-model";
import {
  busiestWorkers,
  deviceCounts,
  leasesHeld,
  stateEnteredAt,
  type WorkerView,
  workersStats,
} from "./workers-model";

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
    } as unknown as NonNullable<WorkerView["devices"]>[number];

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
      servesDefaultMode: true,
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
      servesDefaultMode: true,
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

describe("the busiest workers", () => {
  it("ranks the workers by the leases each holds now, most first, ties in the daemon's order", () => {
    const lease = (id: string) => ({
      deviceId: `dev_${id}`,
      grantedAt: NOW,
      id,
      lastRenewedAt: NOW,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: NOW + 60_000,
      ttlMs: 60_000,
    });
    const fleet = [
      worker({ id: "wrk_one", leases: [lease("l1")] }),
      worker({ id: "wrk_none" }),
      worker({ id: "wrk_three", leases: [lease("l2"), lease("l3"), lease("l4")] }),
      worker({ id: "wrk_also_one", leases: [lease("l5")] }),
    ];

    expect(busiestWorkers(fleet).map((entry) => entry.id)).toEqual([
      "wrk_three",
      "wrk_one",
      "wrk_also_one",
      "wrk_none",
    ]);
    // The daemon's list is left as it came.
    expect(fleet.map((entry) => entry.id)[0]).toBe("wrk_one");
  });

  describe("a worker that reports starting", () => {
    const DEVICE = {
      id: "dev_1",
      mode: "full",
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "ready",
    } as const;
    const LEASE = {
      deviceId: "dev_1",
      grantedAt: NOW,
      id: "l_0",
      lastRenewedAt: NOW,
      ownerId: "agent",
      requesterId: "agent",
      ttlDeadline: NOW + 60_000,
      ttlMs: 60_000,
    };
    // A gateway's view of a starting worker: its health and host, and nothing else it reports.
    const starting: WorkerView = {
      connection: "connected",
      drained: false,
      health: "starting",
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
      id: "wrk_1",
      lastSeenAt: NOW,
    };

    it("the worker's page shows it as starting, and no device, lease or capacity view", () => {
      const shown = text(
        renderToStaticMarkup(<WorkerDetail id="wrk_1" workers={[starting]} now={NOW} />),
      );

      expect(shown).toContain("starting");
      expect(shown).toContain("Devices, leases and capacity appear once startup finishes.");
      expect(shown).not.toContain("No devices.");
      expect(shown).not.toContain("0 leased");
    });

    it("counts no devices, leases or capacity for it, ranks it last by leases, and lists nothing that needs attention on it", () => {
      const busy = worker({ id: "wrk_busy", leases: [{ ...LEASE, id: "l_1" }] });

      expect(deviceCounts(starting)).toBeUndefined();
      expect(leasesHeld([starting, busy])).toBe(1);
      expect(busiestWorkers([starting, busy]).map((entry) => entry.id)).toEqual([
        "wrk_busy",
        "wrk_1",
      ]);
      expect(workersStats([starting]).map((stat) => stat.value)).toEqual(["1", "0", "0", "0"]);
      expect(attentionItems([starting])).toEqual([]);
      expect(stateEnteredAt({ ...DEVICE, state: "leased" }, starting)).toBeUndefined();
      expect(deviceOfLease(LEASE, [starting])).toBeUndefined();
    });

    it("the busiest table shows a dash for its leases", () => {
      const html = renderToStaticMarkup(<BusiestWorkers workers={[starting]} />);

      expect(text(html)).toContain("wrk_1 —");
    });

    it("the worker's card shows it as starting, with no device or capacity count", () => {
      const html = renderToStaticMarkup(<WorkerFacts worker={starting} />);

      expect(html).toContain("status-warn");
      expect(text(html)).toContain("Health starting");
      expect(text(html)).not.toContain("Devices");
      expect(text(html)).not.toContain("Capacity");
    });
  });
});
