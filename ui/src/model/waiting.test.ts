import { describe, expect, it } from "vitest";

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
      { kind: "worker", name: "worker-b", to: "/workers/wrk_2" },
      { kind: "worker", name: "host", to: "/workers/wrk_1" },
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
      to: "/waiting/req%20a%2Fb",
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

  it("chooses the first row of the page when the URL names none", () => {
    expect(chooseWaiting(rows, undefined, rows.slice(1))).toEqual({ chosen: rows[1], gone: false });
  });

  it("chooses the request the URL names, even from another page", () => {
    expect(chooseWaiting(rows, "a", rows.slice(1))).toEqual({ chosen: rows[0], gone: false });
  });

  it("calls a named request that is no longer waiting gone, and chooses nothing", () => {
    expect(chooseWaiting(rows, "granted", rows)).toEqual({ chosen: undefined, gone: true });
  });
});
