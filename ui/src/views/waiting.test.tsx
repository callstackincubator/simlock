import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WaitingTable } from "./waiting";
import { requestedDevice, type WaitingRequest } from "./waiting-model";
import type { WorkerView } from "./workers-model";

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

/** The text a screen shows, without markup. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the Waiting view", () => {
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
    // The copy a gateway sent worker-b, under the gateway's requester id: never the same request,
    // even under the same id.
    const sentOn = request({ id: "req_f", requesterId: "gw:gateway-1:fleet-agent" });
    // Another request from the same requester, under another id: not this one either.
    const another = request({ id: "req_x", requesterId: "fleet-agent" });
    const workers = [
      worker({ id: "wrk_1", label: "host", waiting: [onHost] }),
      worker({ id: "wrk_2", label: "worker-b", waiting: [sentOn] }),
      worker({ id: "wrk_3", label: "worker-c", waiting: [another] }),
    ];

    const html = renderToStaticMarkup(
      <WaitingTable requests={[onGateway, onHost, inFleetQueue]} workers={workers} now={NOW} />,
    );

    expect(html).toContain('href="/workers/wrk_2"');
    expect(text(html)).toContain("agent-b iOS iPhone 16 worker-b queued 1 1 min 15 s");
    expect(html).toContain('href="/workers/wrk_1"');
    expect(text(html)).toContain("agent-b iOS iPhone 16 host queued");
    expect(text(html)).toContain("fleet-agent iOS iPhone 16 — queued");
  });

  it("names a worker the console has no view of by its id", () => {
    const html = renderToStaticMarkup(
      <WaitingTable requests={[request({ workerId: "wrk_gone" })]} workers={[]} now={NOW} />,
    );

    expect(text(html)).toContain("agent-b iOS iPhone 16 wrk_gone queued");
    expect(html).not.toContain("href=");
  });

  it("shows a starting request with no place in the queue, and a stage it does not know as its raw word", () => {
    const starting = request({ id: "req_s", stage: "starting" });
    delete (starting as { queuePosition?: number }).queuePosition;
    // A stage a newer daemon may send, which this console has never heard of.
    const unknown = {
      ...request({ id: "req_u" }),
      stage: "hibernating",
    } as unknown as WaitingRequest;

    const html = renderToStaticMarkup(
      <WaitingTable requests={[starting, unknown]} workers={[]} now={NOW} />,
    );

    expect(text(html)).toContain("starting — 1 min 15 s");
    expect(html).toContain('class="status status-ok"');
    expect(text(html)).toContain("hibernating 1");
    expect(html).toContain('class="status status-idle"');
  });

  it("says so when nothing is waiting", () => {
    const html = renderToStaticMarkup(<WaitingTable requests={[]} workers={[]} now={NOW} />);

    expect(text(html)).toBe("No requests are waiting.");
  });
});
