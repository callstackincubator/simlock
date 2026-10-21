import { describe, expect, it, vi } from "vitest";

import { tokenIdentity } from "../../auth/testing.js";
import type { HttpDispatch } from "../../http/dispatcher-session.js";
import type { Identity } from "../../auth/index.js";
import { FakeClock, NoopLogger } from "../../ports/index.js";
import { allocate } from "./allocate.js";
import type { FrontContext } from "./context.js";
import { FrontMap } from "./front-map.js";

const agent: Identity = tokenIdentity("tok_a");
const leaseId = "00000000000000000000000000000001";

interface AdmitSession {
  readonly onRequestAdmitted?: (id: string, replayed: boolean) => void;
}
type Handler = (input: Record<string, unknown>, session: AdmitSession) => Promise<unknown>;

function setUp() {
  const clock = new FakeClock(1_000);
  const map = new FrontMap(clock);
  const hangUp = new AbortController();
  const calls: { readonly operation: string; readonly input: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    "lease.list": async () => ({ leases: [] }),
    "lease.request": async () => {
      throw new Error("no device");
    },
  };
  const dispatch = (async (operation: string, input: Record<string, unknown>, session: never) => {
    calls.push({ input, operation });
    const handler = handlers[operation];
    if (handler === undefined) throw new Error(`unexpected ${operation}`);
    return handler(input, session);
  }) as unknown as HttpDispatch;
  const link = { value: { forward: vi.fn(), status: vi.fn() } as Record<string, unknown> };
  const context = {
    clock,
    dispatch,
    link: link.value,
    logger: new NoopLogger(),
    map,
  } as unknown as FrontContext;
  const run = () =>
    allocate(context, {
      call: {
        body: {},
        id: 1,
        kind: "request",
        method: "agent_device.lease.allocate",
        params: { leaseId, platform: "ios" },
        text: "",
      },
      identity: agent,
      request: new Request("http://front.test/rpc", { method: "POST", signal: hangUp.signal }),
    });
  const requests = () => calls.filter((call) => call.operation === "lease.request");
  const cancels = () => calls.filter((call) => call.operation === "lease.cancel");
  return { cancels, clock, handlers, hangUp, link: link.value, map, requests, run };
}

// why: the request must stay open until the test admits and settles it, to hang up in between.
function parkedRequest(rig: ReturnType<typeof setUp>) {
  let admit!: () => void;
  let settle!: () => void;
  rig.handlers["lease.request"] = (_input, session) =>
    new Promise((_resolve, reject) => {
      admit = () => session.onRequestAdmitted?.("req_1", false);
      settle = () => reject(new Error("cancelled"));
    });
  return { admit: () => admit(), settle: () => settle() };
}

describe("the allocate front", () => {
  it("offers simlock no download: the lease request names no allowDownload", async () => {
    const rig = setUp();

    await rig.run();

    expect(rig.requests()).toHaveLength(1);
    expect(rig.requests()[0]?.input).not.toHaveProperty("allowDownload");
  });

  it("cancels the lease request when the CLI hangs up before the daemon admits it, as soon as the daemon does", async () => {
    const rig = setUp();
    const parked = parkedRequest(rig);
    const done = rig.run();
    await vi.waitFor(() => expect(rig.requests()).toHaveLength(1));

    rig.hangUp.abort();
    expect(rig.cancels()).toEqual([]);
    parked.admit();

    await vi.waitFor(() => expect(rig.cancels()).toHaveLength(1));
    expect(rig.cancels()[0]?.input).toEqual({ requesterId: leaseId });
    parked.settle();
    await done;
  });

  it("repeats the cancel every second while the request is not cancellable, and stops once it is", async () => {
    const rig = setUp();
    const parked = parkedRequest(rig);
    const answers = ["not-cancellable", "not-cancellable", "cancelled"];
    rig.handlers["lease.cancel"] = async () => ({ result: answers.shift() });
    const done = rig.run();
    await vi.waitFor(() => expect(rig.requests()).toHaveLength(1));
    parked.admit();

    rig.hangUp.abort();
    await vi.waitFor(() => expect(rig.cancels()).toHaveLength(1));
    await vi.waitFor(() => expect(rig.clock.pendingTimerCount).toBe(1));
    rig.clock.advance(999);
    expect(rig.cancels()).toHaveLength(1);
    rig.clock.advance(1);
    await vi.waitFor(() => expect(rig.cancels()).toHaveLength(2));
    await vi.waitFor(() => expect(rig.clock.pendingTimerCount).toBe(1));
    rig.clock.advance(1_000);
    await vi.waitFor(() => expect(rig.cancels()).toHaveLength(3));

    expect(rig.clock.pendingTimerCount).toBe(0);
    parked.settle();
    await done;
    expect(rig.cancels()).toHaveLength(3);
  });

  it("gives up on a lease.list that does not answer within 5 s and goes on to the lease request", async () => {
    const rig = setUp();
    rig.map.add("old", { address: "a", deadline: 500, identity: agent, ttlMs: 60_000 });
    let lists = 0;
    rig.handlers["lease.list"] = async () => {
      lists += 1;
      return lists === 1 ? new Promise(() => undefined) : { leases: [] };
    };
    const done = rig.run();
    await vi.waitFor(() => expect(lists).toBe(1));

    await new Promise((resolve) => setImmediate(resolve));
    rig.clock.advance(4_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(rig.requests()).toEqual([]);
    rig.clock.advance(1);
    await done;

    expect(rig.requests()).toHaveLength(1);
    expect(rig.map.get("old")?.endedAt).toBeUndefined();
  });

  it("sends the host link's leaseRequires on the lease request, and none when the link names none", async () => {
    const plain = setUp();
    await plain.run();
    const needing = setUp();
    needing.link["leaseRequires"] = ["agent-device"];
    await needing.run();

    expect(plain.requests()[0]?.input).not.toHaveProperty("requires");
    expect(needing.requests()[0]?.input).toMatchObject({ requires: ["agent-device"] });
  });

  it("releases the simlock lease and answers notAvailable when the link names no ceiling for the granted lease", async () => {
    const rig = setUp();
    const releases: Record<string, unknown>[] = [];
    rig.handlers["lease.request"] = async () => ({
      device: { address: "udid-1", spec: { model: "iPhone 16" } },
      lease: { ttlDeadline: 5_000, ttlMs: 60_000 },
    });
    rig.handlers["lease.release"] = async (input) => {
      releases.push(input);
      return {};
    };
    (rig.link["status"] as ReturnType<typeof vi.fn>).mockResolvedValue({
      platforms: ["ios"],
      state: "running",
    });

    const answer = await rig.run();

    expect(releases).toEqual([{ leaseId }]);
    expect(await answer?.text()).toContain(
      "agent-device is not available on this simlock: agent-device reported no lease ceiling for this lease",
    );
    expect(rig.link["forward"]).not.toHaveBeenCalled();
  });
});
