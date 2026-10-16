import { describe, expect, it } from "vitest";

import type { EndedLease } from "../../leasing/index.js";
import { FakeAgentDevice } from "../testing.js";
import { AgentDeviceLeaseEnd, recordingFetch, ReleaseScopeRecord } from "./lease-end.js";

const hex = (n: number): string => n.toString(16).padStart(32, "0");
const scope = { clientId: "client-1", leaseProvider: "proxy", runId: "run-1" } as const;
const tenant = "tok_one";

function ended(n: number): EndedLease {
  return {
    deviceId: "dev_1",
    leaseId: hex(n),
    ownerId: tenant,
    platform: "ios",
    reason: "explicit",
  };
}

function rpc(fake: FakeAgentDevice, method: string, params: Record<string, unknown>): Request {
  return new Request(`${fake.baseUrl}/rpc`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    headers: {
      authorization: `Bearer ${fake.token}`,
      "content-type": "application/json",
      "x-agent-device-tenant": tenant,
    },
    method: "POST",
  });
}

const allocateParams = (n: number) => ({
  ...scope,
  leaseId: hex(n),
  platform: "ios",
  ttlMs: 60_000,
  udid: "00000000-0000-0000-0000-000000000001",
});

function setUp() {
  const fake = new FakeAgentDevice();
  const record = new ReleaseScopeRecord();
  return {
    fake,
    leaseEnd: new AgentDeviceLeaseEnd(fake, record),
    record,
    through: recordingFetch(fake, record),
  };
}

function track<T>(promise: Promise<T>): {
  readonly done: () => boolean;
  readonly promise: Promise<T>;
} {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  return { done: () => settled, promise: tracked };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the host's lease-end participant and recording wrapper", () => {
  it("the recording wrapper records the release scope from the allocate reply, and given a reply with a run ID of 129 characters or a client ID holding `/` records no entry", async () => {
    const { fake, record, through } = setUp();

    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    expect(record.get(hex(1))).toEqual({ ...scope, tenantId: tenant });

    fake.editNextAllocateReply({ runId: "r".repeat(129) });
    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(2)));
    fake.editNextAllocateReply({ clientId: "client/1" });
    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(3)));

    expect(record.get(hex(2))).toBeUndefined();
    expect(record.get(hex(3))).toBeUndefined();
  });

  it("release-all while the allocate for that lease is still in flight waits for it; when it succeeds, the participant sends the release with its scope, and an allocate reply for that lease arriving after the participant started writes nothing to the record", async () => {
    const { fake, leaseEnd, record, through } = setUp();
    fake.holdAllocate();
    const allocating = track(through(rpc(fake, "agent_device.lease.allocate", allocateParams(1))));
    await sleep(20);

    const ending = track(leaseEnd.leaseEnded(ended(1), new AbortController().signal));
    await sleep(50);

    expect(ending.done()).toBe(false);
    expect(fake.rpcRequests("agent_device.lease.release")).toEqual([]);
    fake.letAllocateGo();
    await allocating.promise;
    await ending.promise;

    expect(fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
    expect(fake.rpcRequests("agent_device.lease.release")[0]?.params).toEqual({
      ...scope,
      leaseId: hex(1),
      tenantId: tenant,
    });
    expect(record.get(hex(1))).toBeUndefined();

    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    expect(record.get(hex(1))).toBeUndefined();
  });

  it("with `AgentDeviceUpstream.current()` `unavailable` (`starting`), the participant drops the entry and sends nothing", async () => {
    const { fake, leaseEnd, record, through } = setUp();
    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    expect(record.get(hex(1))).toBeDefined();
    fake.setUnavailable("starting");

    await leaseEnd.leaseEnded(ended(1), new AbortController().signal);

    expect(fake.rpcRequests("agent_device.lease.release")).toEqual([]);
    expect(record.get(hex(1))).toBeUndefined();
  });

  it("a lease ended with an already aborted signal, as by `nuke` or after `settle` began, sends nothing and drops the entry", async () => {
    const { fake, leaseEnd, record, through } = setUp();
    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    expect(record.get(hex(1))).toBeDefined();
    const signal = AbortSignal.abort();

    await leaseEnd.leaseEnded(ended(1), signal);

    expect(fake.rpcRequests("agent_device.lease.release")).toEqual([]);
    expect(record.get(hex(1))).toBeUndefined();
  });

  it("a release the agent's CLI hung up on counts as aborted even when the daemon answered it, so the participant still sends the release and the record keeps the scope until then", async () => {
    const { fake, record, through } = setUp();
    await through(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    const hangUp = new AbortController();
    const release = rpc(fake, "agent_device.lease.release", { ...scope, leaseId: hex(1) });
    const body = await release.text();
    // why: this upstream ignores the hang-up and answers success, as a daemon slow to notice would.
    const deaf = {
      current: () => fake.current(),
      fetch: async (request: Request) => {
        const answer = await fake.fetch(
          new Request(request.url, { body, headers: request.headers, method: "POST" }),
        );
        hangUp.abort();
        return answer;
      },
    };
    const sending = recordingFetch(
      deaf,
      record,
    )(
      new Request(release.url, {
        body,
        headers: release.headers,
        method: "POST",
        signal: hangUp.signal,
      }),
    );
    await sending;
    await sleep(20);
    expect(record.get(hex(1))).toBeDefined();

    await new AgentDeviceLeaseEnd(fake, record).leaseEnded(ended(1), new AbortController().signal);

    expect(fake.rpcRequests("agent_device.lease.release")).toHaveLength(2);
  });

  it("a release the agent's CLI hung up on counts as aborted at once when the daemon has not answered, so the participant does not wait for that answer", async () => {
    const { fake, record } = setUp();
    await recordingFetch(fake, record)(rpc(fake, "agent_device.lease.allocate", allocateParams(1)));
    const hangUp = new AbortController();
    const release = rpc(fake, "agent_device.lease.release", { ...scope, leaseId: hex(1) });
    const body = await release.text();
    const silent = {
      current: () => fake.current(),
      fetch: () => new Promise<Response>(() => undefined),
    };
    const sending = track(
      recordingFetch(
        silent,
        record,
      )(
        new Request(release.url, {
          body,
          headers: release.headers,
          method: "POST",
          signal: hangUp.signal,
        }),
      ),
    );
    await sleep(10);
    const ending = track(
      new AgentDeviceLeaseEnd(fake, record).leaseEnded(ended(1), new AbortController().signal),
    );
    await sleep(10);
    expect(ending.done()).toBe(false);
    hangUp.abort();
    await ending.promise;

    expect(sending.done()).toBe(false);
    expect(fake.rpcRequests("agent_device.lease.release")).toHaveLength(1);
  });
});
