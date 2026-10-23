import { describe, expect, it } from "vitest";

import { waitingRequestSchema } from "../../../src/contract/index";
import {
  chooseWaiting,
  requestedDevice,
  type WaitingRequest,
  type WaitingRow,
  waitingTable,
} from "./waiting";
import type { WorkerView } from "./workers";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function request(overrides: Partial<WaitingRequest> = {}): WaitingRequest {
  return {
    createdAt: NOW - 75_000,
    id: "req_1",
    queuePosition: 1,
    requesterId: "agent-b",
    spec: { model: "iPhone 16", platform: "ios" },
    stage: "queued",
    ...overrides,
  };
}

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

function rowOf(overrides: Partial<WaitingRequest> = {}, workers: WorkerView[] = []): WaitingRow {
  const row = waitingTable([request(overrides)], workers, NOW).rows[0];
  if (row === undefined) throw new Error("no row");
  return row;
}

describe("the waiting table", () => {
  it("writes the device a request asked for with only the fields it named", () => {
    expect(requestedDevice({ model: "iPhone 16", platform: "ios" })).toBe("iOS iPhone 16");
    expect(
      requestedDevice({
        imageTag: "google_apis",
        mode: "slim",
        model: "Pixel 8",
        osVersion: "35",
        platform: "android",
      }),
    ).toBe("Android Pixel 8, runtime 35, mode slim, image tag google_apis");
  });

  it("writes a request that named a class or only a platform without a model, never as undefined", () => {
    expect(requestedDevice({ class: "phone", platform: "ios" })).toBe("iOS phone");
    expect(requestedDevice({ platform: "android" })).toBe("Android");
  });

  it("names the worker a request waits on: by its workerId, or on a single host the worker whose view lists the same request", () => {
    const onGateway = request({ id: "req_w", workerId: "wrk_2" });
    const onHost = request({ id: "req_h" });
    const inFleetQueue = request({ id: "req_f", requesterId: "fleet-agent" });
    // why: The copy a gateway sent worker-b, under the gateway's requester id: never the same request,
    // even under the same id.
    const sentOn = request({ id: "req_f", requesterId: "gw:gateway-1:fleet-agent" });
    // why: Another request from the same requester, under another id: not this one either.
    const another = request({ id: "req_x", requesterId: "fleet-agent" });
    const workers = [
      worker({ id: "wrk_1", label: "host", waiting: [onHost] }),
      worker({ id: "wrk_2", label: "worker-b", waiting: [sentOn] }),
      worker({ id: "wrk_3", label: "worker-c", waiting: [another] }),
    ];

    const rows = waitingTable([onGateway, onHost, inFleetQueue], workers, NOW).rows;

    expect(rows.map((row) => row.queue)).toEqual([
      { kind: "worker", name: "worker-b", to: "/fleet/wrk_2" },
      { kind: "worker", name: "host", to: "/fleet/wrk_1" },
      { kind: "gateway" },
    ]);
  });

  it("names a worker the console has no view of by its id", () => {
    expect(rowOf({ workerId: "wrk_gone" }).queue).toEqual({ id: "wrk_gone", kind: "unseen" });
  });

  it("shows a starting request with no place in the queue, and a stage it does not know as its raw word", () => {
    const starting = request({ id: "req_s", stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;
    // why: A stage a newer daemon may send, which this console has never heard of.
    const unknown = {
      ...request({ id: "req_u" }),
      stage: "hibernating",
    } as unknown as WaitingRequest;

    const [first, second] = waitingTable([starting, unknown], [], NOW).rows;

    expect(first).toMatchObject({
      place: "—",
      placeOf: "—",
      stage: { tone: "ok", word: "starting" },
    });
    expect(second).toMatchObject({ place: "#1", stage: { tone: "idle", word: "hibernating" } });
  });

  it("counts a place among the requests of the same queue, the physical queue apart from the virtual one", () => {
    const physical = (id: string, queuePosition: number) =>
      request({
        id,
        queuePosition,
        spec: { model: "iPhone 15 Pro", physical: true, platform: "ios" },
      } as unknown as Partial<WaitingRequest>);
    const rows = waitingTable(
      [
        request({ id: "v1", queuePosition: 1 }),
        request({ id: "v2", queuePosition: 2 }),
        request({ id: "w1", queuePosition: 1, workerId: "wrk_2" }),
        physical("p1", 1),
      ],
      [],
      NOW,
    ).rows;

    expect(rows.map((row) => row.placeOf)).toEqual(["1 of 2", "2 of 2", "1 of 1", "1 of 1"]);
    expect(rows.map((row) => row.physicalQueue)).toEqual([false, false, false, true]);
  });

  it("shows how long a request has waited, when it was created, and the path that opens it", () => {
    expect(rowOf({ id: "req a/b" })).toMatchObject({
      created: "2026-10-02 11:58:45 UTC",
      to: "/queue/req%20a%2Fb",
      waited: "1 min 15 s",
    });
  });

  it("keeps the order the daemon lists the requests in, and counts them with the longest wait", () => {
    const table = waitingTable(
      [
        request({ id: "a", createdAt: NOW - 10_000 }),
        request({ id: "b", createdAt: NOW - 75_000 }),
      ],
      [],
      NOW,
    );

    expect(table.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(table.meta).toBe("2 waiting · longest 1 min 15 s");
  });

  it("says 0 waiting when nothing is waiting", () => {
    expect(waitingTable([], [], NOW)).toEqual({ meta: "0 waiting", rows: [] });
  });
});

describe("choosing a waiting request", () => {
  const rows = waitingTable([request({ id: "a" }), request({ id: "b" })], [], NOW).rows;

  it("chooses nothing when the URL names none, so the drawer stays shut", () => {
    expect(chooseWaiting(rows, undefined)).toEqual({ chosen: undefined, gone: false });
  });

  it("chooses the request the URL names, whatever page it is on", () => {
    expect(chooseWaiting(rows, "a")).toEqual({ chosen: rows[0], gone: false });
  });

  it("calls a named request that is no longer waiting gone, and chooses nothing", () => {
    expect(chooseWaiting(rows, "granted")).toEqual({ chosen: undefined, gone: true });
  });
});

describe("why a request waits", () => {
  const withReason = (reason: string, platform: "ios" | "android" = "ios") =>
    rowOf({
      reason,
      spec: { model: "Device", platform },
    } as unknown as Partial<WaitingRequest>);
  const whyOf = (row: WaitingRow) => (row as { why?: string }).why;

  it.each([
    ["behind-earlier-request", "ios", "Behind an earlier request"],
    ["device-limit", "ios", "Full: device limit"],
    ["ram-budget", "ios", "Full: RAM budget"],
    ["global-running-limit", "ios", "Full: running limit"],
    ["platform-running-limit", "ios", "Full: running limit for iOS"],
    ["platform-running-limit", "android", "Full: running limit for Android"],
    ["waiting-for-device", "ios", "A matching device is starting"],
    ["no-free-physical", "ios", "Every matching device is leased or absent"],
  ] as const)("is the text for %s on %s: %s", (reason, platform, text) => {
    expect(whyOf(withReason(reason, platform))).toBe(text);
  });

  it("is the raw word for a reason a newer daemon sends, and absent for a request with no reason", () => {
    expect(whyOf(withReason("hibernating"))).toBe("hibernating");
    expect(whyOf(rowOf())).toBeUndefined();
  });

  it("has a text for every reason the contract's enum lists", () => {
    const field = (waitingRequestSchema.shape as Record<string, unknown>)["reason"];
    expect(field).toBeDefined();
    const listed = (field as { unwrap(): { options: readonly string[] } }).unwrap().options;

    expect(listed).toHaveLength(7);
    for (const reason of listed) {
      const why = whyOf(withReason(reason));
      expect(why).toBeDefined();
      expect(why).not.toBe(reason);
    }
  });
});

describe("the waiting table on a gateway", () => {
  const gatewayWorkers: NonNullable<WaitingRequest["workers"]> = [
    { reason: "drained", workerId: "wrk_1" },
    { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_2" },
    { reason: "busy", workerId: "wrk_gone" },
  ];

  it("gives one Why row per worker, named by its label, else its id, else the raw id of a worker it has no view of", () => {
    const row = rowOf({ workers: gatewayWorkers }, [
      worker({ id: "wrk_1", label: "mac-mini-1" }),
      worker({ id: "wrk_2" }),
    ]);

    expect(row.workers).toEqual([
      { name: "mac-mini-1", text: "Drained" },
      { name: "wrk_2", text: "Full: running limit for iOS" },
      { name: "wrk_gone", text: "Busy with its own queue" },
    ]);
  });

  it("writes the platform of the request into the running limit and the driver", () => {
    const android = { spec: { model: "Pixel 8", platform: "android" as const } };

    expect(
      rowOf({
        ...android,
        workers: [
          { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_1" },
          { reason: "no-driver", workerId: "wrk_2" },
        ],
      }).workers?.map((entry) => entry.text),
    ).toEqual(["Full: running limit for Android", "No Android support"]);
  });

  it.each([
    ["disconnected", undefined, "Not connected"],
    ["incompatible", undefined, "Protocol mismatch"],
    ["not-ready", undefined, "Not ready yet"],
    ["unhealthy", undefined, "Not running"],
    ["updating", undefined, "Updating"],
    ["drained", undefined, "Drained"],
    ["busy", undefined, "Busy with its own queue"],
    ["no-driver", undefined, "No iOS support"],
    ["unknown-model", undefined, "Model not offered"],
    ["runtime-missing", undefined, "OS not installed"],
    ["capability-missing", undefined, "Missing capability"],
    ["full", undefined, "Full"],
    ["full", "device-limit", "Full: device limit"],
    ["full", "ram-budget", "Full: RAM budget"],
    ["full", "global-running-limit", "Full: running limit"],
    ["no-free-physical", undefined, "Every matching device is leased or absent"],
    ["not-chosen", undefined, "Not chosen this time"],
  ] as const)("writes %s with capacity reason %s as '%s'", (reason, capacityReason, text) => {
    const entry = { ...(capacityReason === undefined ? {} : { capacityReason }), reason };

    expect(rowOf({ workers: [{ ...entry, workerId: "wrk_1" }] }).workers).toEqual([
      { name: "wrk_1", text },
    ]);
  });

  it("has a text for every gateway reason the contract's enum lists", () => {
    const field = (waitingRequestSchema.shape as Record<string, unknown>)["workers"];
    expect(field).toBeDefined();
    const listed = (
      field as { unwrap(): { element: { shape: { reason: { options: readonly string[] } } } } }
    ).unwrap().element.shape.reason.options;

    expect(listed).toHaveLength(14);
    for (const reason of listed) {
      const text = rowOf({ workers: [{ reason, workerId: "wrk_1" } as never] }).workers?.[0]?.text;
      expect(text).toMatch(/^[A-Z]/);
      expect(text).not.toContain("-");
    }
  });

  it("shows a reason it has no text for as the word the daemon sent", () => {
    const row = rowOf({ workers: [{ reason: "from-the-future", workerId: "wrk_1" } as never] });

    expect(row.workers?.[0]?.text).toBe("from-the-future");
  });

  it("keeps a single-host entry's one Why row and gives it no worker rows", () => {
    const row = rowOf({ reason: "ram-budget" });

    expect(row.why).toBe("Full: RAM budget");
    expect(row.workers).toBeUndefined();
  });
});
