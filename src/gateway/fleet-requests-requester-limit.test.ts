import { describe, expect, it } from "vitest";
import type { LeaseRecord } from "../admin/index.js";
import {
  deviceFixture,
  grantFixture,
  leaseFixture,
  ScriptedWorkerClient,
  statusFixture,
} from "./test-support.js";
import {
  GATEWAY_PREFIX,
  buildFleet,
  connectWorker,
  tick,
  REQUEST,
  saturatedIos,
  requestOptions,
} from "./test-fleet.js";

describe("FleetLeaseCoordinator: a requester may hold up to lease.maxPerRequester fleet leases (ADR 0023)", () => {
  const held = (id: string, grantedAt: number, requester = "agent-1") => ({
    grantedAt,
    id,
    ownerId: requester,
    requesterId: `${GATEWAY_PREFIX}${requester}`,
  });
  const atLimit = (held: number, limit: number, leaseId: string) =>
    `Requester agent-1 already holds ${String(held)} leases and lease.maxPerRequester is ${String(limit)}; release one (\`simlock release ${leaseId}\`) before requesting another device`;
  const waitingMessage =
    "Requester agent-1 already has a waiting request; wait for it to be granted or cancel it before requesting another device";

  async function withWaitingRequest(maxPerRequester?: number) {
    const built = buildFleet(maxPerRequester === undefined ? {} : { maxPerRequester });
    connectWorker(built.workers, "wrk_a", { capacity: saturatedIos() });
    built.directory.add("wrk_a", new ScriptedWorkerClient());
    void built.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
    await tick();
    expect(built.coordinator.queueDepth).toBe(1);
    return built;
  }

  it("with no limit set, a requester holding a fleet lease is refused with today's message, naming that lease", async () => {
    const { coordinator, leaseIndex } = buildFleet();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding two fleet leases is refused, naming the earlier-granted one", async () => {
    const { coordinator, leaseIndex } = buildFleet({ maxPerRequester: 2 });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_9", 10), held("lse_1", 20)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_9",
      message: atLimit(2, 2, "wrk_a.lse_9"),
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester holding one fleet lease is not refused", async () => {
    const { coordinator, directory, leaseIndex, workers } = buildFleet({ maxPerRequester: 2 });
    const client = new ScriptedWorkerClient();
    directory.add("wrk_a", client);
    connectWorker(workers, "wrk_a");
    client.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    await expect(coordinator.request(REQUEST, requestOptions())).resolves.toMatchObject({
      lease: expect.anything(),
    });
  });

  describe("per platform", () => {
    const ANDROID_REQUEST = {
      physical: false,
      model: "Pixel 9",
      osVersion: "26.0",
      platform: "android" as const,
    };
    const iosHeld = (): LeaseRecord => ({
      ...(leaseFixture("lse_1", "dev_1") as LeaseRecord),
      requesterId: `${GATEWAY_PREFIX}agent-1`,
    });
    const androidGrant = () => {
      const base = grantFixture();
      return grantFixture({
        device: {
          ...base.device,
          id: "dev_2",
          spec: { ...base.device.spec, model: "Pixel 9", platform: "android" },
        },
        lease: leaseFixture("lse_2", "dev_2") as LeaseRecord,
      });
    };
    const iosRefusal = (leaseId: string) =>
      `Requester agent-1 already holds iOS lease ${leaseId}; release it (\`simlock release ${leaseId}\`) before requesting another iOS device`;
    const twoWorkers = (built: ReturnType<typeof buildFleet>, held: LeaseRecord[] = []) => {
      const ios = new ScriptedWorkerClient();
      const android = new ScriptedWorkerClient();
      built.directory.add("wrk_a", ios);
      built.directory.add("wrk_b", android);
      connectWorker(built.workers, "wrk_a", {
        devices: held.length === 0 ? [] : [deviceFixture("dev_1", "leased")],
        leases: held,
      });
      connectWorker(built.workers, "wrk_b", { models: ["Pixel 9"], platform: "android" });
      return { android, ios };
    };

    it("with lease.maxPerRequester per platform, a requester holding an iOS fleet lease is granted an Android one on another worker and refused a second iOS one, also once the index is rebuilt from worker views alone", async () => {
      const limit = { ios: 1, android: 1 };
      const live = buildFleet({ maxPerRequester: limit });
      const liveWorkers = twoWorkers(live);
      liveWorkers.ios.requestLeaseQueue.push({ grant: grantFixture(), kind: "grant" });
      liveWorkers.android.requestLeaseQueue.push({ grant: androidGrant(), kind: "grant" });
      await live.coordinator.request(REQUEST, requestOptions());

      const android = await live.coordinator.request(ANDROID_REQUEST, requestOptions());
      const second = await live.coordinator
        .request(REQUEST, requestOptions())
        .catch((e: unknown) => e);

      expect(android.lease.id).toBe("wrk_b.lse_2");
      expect(second).toMatchObject({
        existingLeaseId: "wrk_a.lse_1",
        message: iosRefusal("wrk_a.lse_1"),
        name: "RequesterAlreadyLeasedError",
      });

      const rebuilt = buildFleet({ maxPerRequester: limit });
      const rebuiltWorkers = twoWorkers(rebuilt, [iosHeld()]);
      rebuiltWorkers.android.requestLeaseQueue.push({ grant: androidGrant(), kind: "grant" });

      const againIos = await rebuilt.coordinator
        .request(REQUEST, requestOptions())
        .catch((e: unknown) => e);
      const againAndroid = await rebuilt.coordinator.request(ANDROID_REQUEST, requestOptions());

      expect(againIos).toMatchObject({ message: iosRefusal("wrk_a.lse_1") });
      expect(againAndroid.lease.id).toBe("wrk_b.lse_2");
    });
  });

  it("with a numeric limit of 1, a requester holding an iOS and an Android fleet lease is refused with today's message, naming the earlier one", async () => {
    const { coordinator, leaseIndex } = buildFleet({ maxPerRequester: 1 });
    leaseIndex.rebuildFromWorker(
      "wrk_a",
      [
        { ...held("lse_2", 20), deviceId: "dev_2" },
        { ...held("lse_1", 10), deviceId: "dev_1" },
      ],
      [
        { id: "dev_1", spec: { platform: "ios" } },
        { id: "dev_2", spec: { platform: "android" } },
      ],
    );

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with lease.maxPerRequester per platform, a fleet lease whose device a worker view does not list counts against every platform", async () => {
    const { coordinator, leaseIndex } = buildFleet({ maxPerRequester: { ios: 1, android: 1 } });
    leaseIndex.rebuildFromWorker("wrk_a", [{ ...held("lse_1", 10), deviceId: "dev_unlisted" }], []);

    const refusal = await coordinator
      .request({ ...REQUEST, model: "Pixel 9", platform: "android" }, requestOptions())
      .catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message:
        "Requester agent-1 already holds Android lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another Android device",
      name: "RequesterAlreadyLeasedError",
    });
  });

  describe("per platform, waiting", () => {
    it("with lease.maxPerRequester per platform, a requester may wait for an iOS and an Android lease at once but not two of one platform, and lease.cancel names which one to cancel", async () => {
      const built = buildFleet({ maxPerRequester: { ios: 1, android: 1 } });
      const capacity = statusFixture().capacity;
      built.directory.add("wrk_a", new ScriptedWorkerClient());
      built.directory.add("wrk_b", new ScriptedWorkerClient());
      connectWorker(built.workers, "wrk_a", { capacity: saturatedIos() });
      connectWorker(built.workers, "wrk_b", {
        capacity: { ...capacity, android: { ...capacity.android, maxRunning: 0 } },
        models: ["Pixel 9"],
        platform: "android",
      });
      const androidRequest = {
        physical: false,
        model: "Pixel 9",
        osVersion: "26.0",
        platform: "android" as const,
      };
      void built.coordinator.request(REQUEST, requestOptions()).catch(() => undefined);
      await tick();

      const android = built.coordinator.request(androidRequest, requestOptions());
      void android.catch(() => undefined);
      await tick();
      const secondIos = await Promise.race([
        built.coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e),
        tick().then(() => "admitted"),
      ]);
      const platformsWaiting = () =>
        built.coordinator
          .waitingRequests()
          .map((waiting) => waiting.spec.platform)
          .sort();

      expect(platformsWaiting()).toEqual(["android", "ios"]);
      expect(secondIos).toMatchObject({
        message:
          "Requester agent-1 already has a waiting iOS request; wait for it to be granted or cancel it before requesting another iOS device",
        name: "RequesterAlreadyLeasedError",
      });
      await expect(built.coordinator.cancelPending("agent-1", "android")).resolves.toBe(
        "cancelled",
      );
      expect(platformsWaiting()).toEqual(["ios"]);
    });
  });

  it("with limit 2, a requester with a waiting fleet request is refused with the waiting-request message", async () => {
    const { coordinator } = await withWaitingRequest(2);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with limit 2, a requester with a waiting fleet request that also holds two fleet leases gets the waiting-request message", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest(2);
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1), held("lse_2", 2)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      message: waitingMessage,
      name: "RequesterAlreadyLeasedError",
    });
  });

  it("with no limit set, a requester that holds a fleet lease and has a waiting request gets today's message naming that lease", async () => {
    const { coordinator, leaseIndex } = await withWaitingRequest();
    leaseIndex.rebuildFromWorker("wrk_a", [held("lse_1", 1)]);

    const refusal = await coordinator.request(REQUEST, requestOptions()).catch((e: unknown) => e);

    expect(refusal).toMatchObject({
      existingLeaseId: "wrk_a.lse_1",
      message:
        "Requester agent-1 already holds lease wrk_a.lse_1; release it (`simlock release wrk_a.lse_1`) before requesting another device",
    });
  });
});
