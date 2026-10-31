import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, FakeInputFactory, fakeDeviceDataTables } from "../core/testing.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

const holder: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "holder-1",
  role: "agent",
};

describe("device.rotate", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function worker(options: {
    readonly inputModule: boolean;
    readonly input: FakeInputFactory | undefined;
    readonly androidInput?: FakeInputFactory;
  }) {
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-rotate-"));
    directories.push(dataDirectory);
    const drivers = [
      new FakeDriver({
        availableOsVersions: ["18.0"],
        clock: new SystemClock(),
        ...(options.input === undefined ? {} : { input: options.input }),
        knownModels: ["iPhone 15", "iPad Pro", "Apple TV 4K", "Mystery Box"],
        physicalDevices: [
          { class: "phone", ids: ["PHONE-1"], model: "iPhone 15", osVersion: "18.0" },
          { class: "tablet", ids: ["TABLET-1"], model: "iPad Pro", osVersion: "18.0" },
        ],
        platform: "ios",
      }),
      new FakeDriver({
        availableOsVersions: ["15"],
        clock: new SystemClock(),
        ...(options.androidInput === undefined ? {} : { input: options.androidInput }),
        knownModels: ["Pixel 8"],
        physicalDevices: [
          { class: "phone", ids: ["DROID-1"], model: "Pixel 8", osVersion: "15" },
          { class: "tablet", ids: ["DROID-2"], model: "Pixel Tablet", osVersion: "15" },
        ],
        platform: "android",
      }),
    ];
    const daemon = await startDaemon({
      configOverrides: { capabilities: { input: { enabled: options.inputModule } } },
      dataDirectory,
      deviceDataTables: fakeDeviceDataTables,
      drivers,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15", platform: "ios" },
      holder,
    );
    return { daemon, drivers, leaseId: (granted as { lease: { id: string } }).lease.id };
  }

  it(
    "answers a holder's rotate of its iOS-simulator lease and sends the helper that orientation",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { daemon, leaseId } = await worker({ input, inputModule: false });

      const answer = await daemon.dispatch(
        "device.rotate",
        { leaseId, orientation: "landscape_left" },
        holder,
      );

      expect(answer).toEqual({ leaseId, orientation: "landscape_left" });
      expect(input.opened).toHaveLength(1);
      expect(input.opened[0]?.sent).toEqual([
        { kind: "orientation", orientation: "landscape_left" },
      ]);
      expect(input.opened[0]?.closes).toBe(1);
    },
  );

  it(
    "refuses a caller that rotates a lease it may not touch, or names a bad orientation",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { daemon, leaseId } = await worker({ input, inputModule: false });
      const other: DispatchSession = { ...holder, principal: "holder-2" };
      const admin: DispatchSession = { ...holder, principal: "gateway-1", role: "admin" };
      const orientation = "landscape_left";

      await expect(
        daemon.dispatch("device.rotate", { leaseId, orientation }, holder),
      ).resolves.toEqual({ leaseId, orientation });

      const refused: readonly (readonly [object, unknown, DispatchSession])[] = [
        [{ name: "UnknownLeaseError" }, { leaseId: "nope", orientation }, holder],
        [{ code: "FORBIDDEN" }, { leaseId, orientation }, other],
        [{ code: "FORBIDDEN" }, { leaseId, orientation, requesterId: "holder-1" }, holder],
        [{ code: "FORBIDDEN" }, { leaseId, orientation, requesterId: "someone-else" }, admin],
        [{ code: "BAD_REQUEST" }, { leaseId, orientation: "landscape-left" }, holder],
        [{ code: "BAD_REQUEST" }, { leaseId, orientation: "auto" }, holder],
        [{ code: "BAD_REQUEST" }, { leaseId, orientation: "" }, holder],
      ];
      for (const [expected, body, session] of refused) {
        await expect(
          daemon.dispatch("device.rotate", body as never, session),
          JSON.stringify(body),
        ).rejects.toMatchObject(expected);
      }
      expect(input.opened).toHaveLength(1);
    },
  );

  it(
    "refuses a holder's rotate of a lease not on an iOS phone or tablet simulator with ROTATION_UNSUPPORTED naming it",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const androidInput = new FakeInputFactory({
        height: 2400,
        orientation: "portrait",
        width: 1080,
      });
      const { daemon, drivers } = await worker({ androidInput, input, inputModule: false });
      const admin: DispatchSession = { ...holder, principal: "admin-1", role: "admin" };
      const orientation = "landscape_left";

      async function lease(principal: string, request: object, enroll?: string) {
        const session: DispatchSession = { ...holder, principal };
        if (enroll !== undefined) {
          for (const driver of drivers) driver.setPhysicalPresence(enroll, true);
          await daemon.dispatch(
            "device.add",
            { id: enroll, platform: (request as { platform: "ios" | "android" }).platform },
            admin,
          );
        }
        const granted = await daemon.dispatch("lease.request", request as never, session);
        return { id: (granted as { lease: { id: string } }).lease.id, session };
      }

      const cases: readonly (readonly [string, object, string | undefined, string, object])[] = [
        [
          "tv",
          { model: "Apple TV 4K", platform: "ios" },
          undefined,
          "an Apple TV simulator",
          { class: "tv", physical: false, platform: "ios" },
        ],
        [
          "unknown family",
          { model: "Mystery Box", platform: "ios" },
          undefined,
          "a Mystery Box simulator",
          { class: "unknown", physical: false, platform: "ios" },
        ],
        [
          "emulator",
          { model: "Pixel 8", platform: "android" },
          undefined,
          "an Android emulator",
          { class: "emulator", physical: false, platform: "android" },
        ],
        [
          "android phone",
          { model: "Pixel 8", physical: true, platform: "android" },
          "DROID-1",
          "an Android phone",
          { class: "phone", physical: true, platform: "android" },
        ],
        [
          "android tablet",
          { model: "Pixel Tablet", physical: true, platform: "android" },
          "DROID-2",
          "an Android tablet",
          { class: "tablet", physical: true, platform: "android" },
        ],
        [
          "iphone",
          { model: "iPhone 15", physical: true, platform: "ios" },
          "PHONE-1",
          "an iPhone",
          { class: "phone", physical: true, platform: "ios" },
        ],
        [
          "ipad",
          { model: "iPad Pro", physical: true, platform: "ios" },
          "TABLET-1",
          "an iPad",
          { class: "tablet", physical: true, platform: "ios" },
        ],
      ];
      for (const [name, request, enroll, phrase, details] of cases) {
        const { id, session } = await lease(`holder-${name}`, request, enroll);
        await expect(
          daemon.dispatch("device.rotate", { leaseId: id, orientation }, session),
          name,
        ).rejects.toMatchObject({
          code: "ROTATION_UNSUPPORTED",
          details: { leaseId: id, ...details },
          message: `Lease ${id} is on ${phrase}; only an iOS simulator can be rotated`,
        });
      }

      const ipad = await lease("holder-ipad-simulator", { model: "iPad Pro", platform: "ios" });
      await expect(
        daemon.dispatch("device.rotate", { leaseId: ipad.id, orientation }, ipad.session),
      ).resolves.toEqual({ leaseId: ipad.id, orientation });
      expect(input.opened).toHaveLength(1);
      expect(androidInput.opened).toHaveLength(0);
    },
  );

  it(
    "refuses a holder's rotate with INPUT_UNAVAILABLE and the reason when the helper cannot start or the write fails",
    { timeout: 60_000 },
    async () => {
      const screen = { height: 2556, orientation: "portrait", width: 1179 } as const;
      const cut = "x".repeat(300);
      const cases: readonly (readonly [
        string,
        (input: FakeInputFactory) => void,
        string,
        boolean,
      ])[] = [
        ["no factory", () => undefined, "ios devices take no input", false],
        [
          "open rejects",
          (input) => {
            input.failWith = new Error("helper exploded");
          },
          "helper exploded",
          true,
        ],
        [
          "open rejects with a long message",
          (input) => {
            input.failWith = new Error(cut);
          },
          "x".repeat(200),
          true,
        ],
        [
          "open rejects with no message",
          (input) => {
            input.failWith = new Error("");
          },
          "unknown error",
          true,
        ],
        [
          "write rejects",
          (input) => {
            input.sendFailure = new Error("pipe closed");
          },
          "pipe closed",
          true,
        ],
      ];
      for (const [name, arrange, reason, hasFactory] of cases) {
        const input = new FakeInputFactory(screen);
        arrange(input);
        const { daemon, leaseId } = await worker({
          input: hasFactory ? input : undefined,
          inputModule: false,
        });

        await expect(
          daemon.dispatch("device.rotate", { leaseId, orientation: "landscape_left" }, holder),
          name,
        ).rejects.toMatchObject({
          code: "INPUT_UNAVAILABLE",
          details: { leaseId, reason },
          message: `Lease ${leaseId}'s simulator cannot take input: ${reason}`,
        });
        expect(
          input.opened.map((opened) => opened.closes),
          name,
        ).toEqual(input.opened.map(() => 1));
        await daemons.pop()?.stop("test");
      }
    },
  );
});
