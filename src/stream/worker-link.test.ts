import { describe, expect, it } from "vitest";

import { createWorkerStreamLink, type StreamDevice, type StreamRegistry } from "./worker-link.js";
import { StreamRefusalError } from "./refusal.js";
import type { StreamCaller } from "./caller.js";

const AGENT: StreamCaller = { principal: "tok_agent", requesterId: "agent-1", role: "agent" };
const OPERATOR: StreamCaller = { principal: "tok_op", role: "operator" };

function registry(
  leases: Readonly<Record<string, { ownerId: string; requesterId: string }>>,
  devices: Readonly<Record<string, StreamDevice>> = {},
): StreamRegistry {
  return {
    deviceOfLease: (leaseId) => devices[leaseId],
    leaseOwner: (leaseId) => leases[leaseId],
  };
}

const HELD = { lse_mine: { ownerId: "tok_agent", requesterId: "agent-1" } };
const SIMULATOR = { lse_mine: { address: "UDID", physical: false, platform: "ios" } };

async function refusalOf(
  link: { serve(id: string, caller: StreamCaller, signal: AbortSignal): Promise<unknown> },
  leaseId: string,
  caller: StreamCaller,
): Promise<StreamRefusalError> {
  const served = await link.serve(leaseId, caller, new AbortController().signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(served, "the stream was expected to be refused").toBeInstanceOf(StreamRefusalError);
  return served as StreamRefusalError;
}

function linkFor(registryValue: StreamRegistry, options: { available?: boolean } = {}) {
  return createWorkerStreamLink({
    ...(options.available === undefined
      ? {}
      : { available: async () => options.available === true }),
    args: [],
    command: "/does/not/matter",
    leaseEnvironment: {},
    registry: registryValue,
  });
}

describe("the worker's stream link", () => {
  it("refuses a lease it does not hold with the answer every other route gives", async () => {
    const refusal = await refusalOf(
      linkFor(registry(HELD, SIMULATOR)),
      "lse_nope",
      OPERATOR,
    );
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_LEASE"]);
  });

  it("answers an agent reaching for another requester's lease exactly as if it did not exist", async () => {
    const link = linkFor(
      registry(
        { lse_theirs: { ownerId: "tok_other", requesterId: "agent-2" } },
        { lse_theirs: SIMULATOR["lse_mine"] },
      ),
    );
    const refusal = await refusalOf(link, "lse_theirs", AGENT);
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_LEASE"]);
    // why: the message must not say "not yours" either -- an agent that can tell a lease it cannot have
    // from a lease that does not exist can enumerate the fleet's leases by asking for their pictures.
    expect(refusal.message).toBe("Unknown lease: lse_theirs");
  });

  it("refuses a device that can never produce a picture, naming that as its own reason", async () => {
    for (const [name, device] of [
      ["a physical device", { address: "UDID", physical: true, platform: "ios" }],
      ["an emulator", { address: "emulator-5554", physical: false, platform: "android" }],
    ] as const) {
      const link = linkFor(registry(HELD, { lse_mine: device }));
      const refusal = await refusalOf(link, "lse_mine", OPERATOR);
      expect([refusal.status, refusal.code], name).toEqual([415, "STREAM_NOT_SUPPORTED"]);
    }
  });

  it("says a capture program that is not there is unavailable rather than a bad request", async () => {
    // why: 503 and not 400 -- the lease and the ask are both fine, so the viewer that asks again after
    // its operator installs the tool is right to ask the same thing.
    const refusal = await refusalOf(
      linkFor(registry(HELD, SIMULATOR), { available: false }),
      "lse_mine",
      OPERATOR,
    );
    expect([refusal.status, refusal.code]).toEqual([503, "STREAM_UNAVAILABLE"]);
    expect(refusal.message).toContain("/does/not/matter");
  });

  it("refuses on ownership before it looks for a capture program", async () => {
    // why: the order is what keeps an agent's reach the only question asked of an agent. A link that
    // checked its tooling first would answer an agent with a different refusal for a lease that exists
    // on this worker than for one that does not.
    const link = createWorkerStreamLink({
      available: async () => false,
      args: [],
      command: "/does/not/matter",
      leaseEnvironment: {},
      registry: registry(HELD, SIMULATOR),
    });
    const refusal = await refusalOf(link, "lse_nope", AGENT);
    expect([refusal.status, refusal.code]).toEqual([404, "UNKNOWN_LEASE"]);
  });

  it("an operator reaches a lease without naming a requester", async () => {
    // why: an operator owns the whole machine, so the refusal this link must NOT raise is the point --
    // a link that demanded a requester id it never gets from an operator's token would answer an
    // operator's own console with 404s. Reaching the spawn is as far as this goes without a real tool.
    const refusal = await refusalOf(linkFor(registry(HELD, SIMULATOR)), "lse_mine", OPERATOR);
    expect(refusal.code).toBe("STREAM_UNAVAILABLE");
  });
});
