import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { FakeDriver, FakeInputFactory, fakeDeviceDataTables } from "../core/testing.js";
import { FakeSystemStats, MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

const holder: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "holder-1",
  role: "agent",
};

describe("device.rotate", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function startWorker(options: {
    readonly inputModule: boolean;
    readonly input: FakeInputFactory | undefined;
    readonly androidInput?: FakeInputFactory;
    readonly httpPort?: number;
    readonly gateway?: { readonly label: string; readonly token: string; readonly url: string };
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
      configOverrides: {
        capabilities: { input: { enabled: options.inputModule } },
        ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
        ...(options.httpPort === undefined
          ? {}
          : { http: { enabled: true, host: "127.0.0.1", port: options.httpPort } }),
      },
      dataDirectory,
      deviceDataTables: fakeDeviceDataTables,
      drivers,
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      systemStats: new FakeSystemStats({ cpuCount: 16, totalRamBytes: 64 * 1024 ** 3 }),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    return { daemon, drivers };
  }

  async function worker(options: Parameters<typeof startWorker>[0]) {
    const { daemon, drivers } = await startWorker(options);
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15", platform: "ios" },
      holder,
    );
    return { daemon, drivers, leaseId: (granted as { lease: { id: string } }).lease.id };
  }

  it(
    "answers a holder's rotate of its iOS-simulator lease to each of the four orientation names and sends the helper that orientation",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { daemon, leaseId } = await worker({ input, inputModule: false });

      const names = [
        "landscape_left",
        "portrait_upside_down",
        "landscape_right",
        "portrait",
      ] as const;
      for (const [index, orientation] of names.entries()) {
        const answer = await daemon.dispatch("device.rotate", { leaseId, orientation }, holder);

        expect(answer, orientation).toEqual({ leaseId, orientation });
        expect(input.opened, orientation).toHaveLength(index + 1);
        expect(input.opened[index]?.sent, orientation).toEqual([
          { kind: "orientation", orientation },
        ]);
        expect(input.opened[index]?.closes, orientation).toBe(1);
      }
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
    "refuses a holder's rotate with INPUT_UNAVAILABLE and the reason when the helper cannot start or the write fails, and closes a socket whose write fails 1013 while the daemon keeps running",
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

      const failing = new FakeInputFactory(screen);
      failing.sendFailure = new Error("pipe closed");
      const { daemon, leaseId, openSocket, session } = await holderWithSocketAccess(failing);
      const socket = await openSocket();
      sockets.at(-1)?.send(Buffer.concat([Buffer.from([0x04]), Buffer.from('{"button":"lock"}')]));
      await vi.waitFor(() => expect(socket.code).toBe(1013), { timeout: 10_000 });
      await expect(
        daemon.dispatch("device.rotate", { leaseId, orientation: "portrait" }, session),
      ).rejects.toMatchObject({ code: "INPUT_UNAVAILABLE", details: { reason: "pipe closed" } });
    },
  );

  async function holderWithSocketAccess(input: FakeInputFactory) {
    const httpPort = await freeLoopbackPort();
    const { daemon } = await worker({ httpPort, input, inputModule: true });
    const admin: DispatchSession = { ...holder, principal: "operator", role: "admin" };
    const created = await daemon.dispatch(
      "token.create",
      { label: "holder", role: "agent" },
      admin,
    );
    const session: DispatchSession = { ...holder, principal: created.token.id };
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15", platform: "ios" },
      session,
    );
    const leaseId = (granted as { lease: { id: string } }).lease.id;
    return {
      daemon,
      leaseId,
      openSocket: async () => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${String(httpPort)}/v1/leases/${leaseId}/input`,
          {
            headers: { authorization: `Bearer ${created.secret}` },
          },
        );
        sockets.push(socket);
        const messages: number[] = [];
        const closed: { code: number | undefined } = { code: undefined };
        socket.on("message", (data) => messages.push((data as Buffer)[0] ?? -1));
        socket.on("close", (code) => {
          closed.code = code;
        });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("error", reject);
        });
        await vi.waitFor(() => expect(messages).toEqual([0x83, 0x82]), { timeout: 10_000 });
        return closed;
      },
      session,
    };
  }

  it(
    "gives a rotate after a failed open, an input socket opened after a rotate's helper closed, and a rotate after the shared helper failed a fresh helper, keeps a socket's helper through a rotate, and answers UNKNOWN_LEASE when the lease is reclaimed while the rotate's helper opens",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { daemon, leaseId, openSocket, session } = await holderWithSocketAccess(input);
      const orientation = "landscape_right";

      input.failWith = new Error("helper exploded");
      await expect(
        daemon.dispatch("device.rotate", { leaseId, orientation }, session),
      ).rejects.toMatchObject({
        code: "INPUT_UNAVAILABLE",
        details: { reason: "helper exploded" },
      });
      input.failWith = undefined;
      expect(input.opened).toHaveLength(0);

      await daemon.dispatch("device.rotate", { leaseId, orientation }, session);
      expect(input.opened).toHaveLength(1);
      expect(input.opened[0]?.closes).toBe(1);

      const socket = await openSocket();
      expect(input.opened).toHaveLength(2);
      expect(input.opened[1]?.closes).toBe(0);

      await expect(
        daemon.dispatch("device.rotate", { leaseId, orientation: "portrait" }, session),
      ).resolves.toEqual({ leaseId, orientation: "portrait" });
      expect(input.opened).toHaveLength(2);
      expect(input.opened[1]?.sent).toEqual([{ kind: "orientation", orientation: "portrait" }]);
      expect(input.opened[1]?.closes).toBe(0);

      input.opened[1]?.fail(new Error("pipe closed"));
      await expect(
        daemon.dispatch("device.rotate", { leaseId, orientation }, session),
      ).resolves.toEqual({ leaseId, orientation });
      expect(input.opened).toHaveLength(3);
      expect(input.opened[1]?.sent).toEqual([{ kind: "orientation", orientation: "portrait" }]);
      expect(input.opened[2]?.sent).toEqual([{ kind: "orientation", orientation }]);
      await vi.waitFor(() => expect(socket.code).toBe(1013), { timeout: 10_000 });

      let open: () => void = () => undefined;
      input.gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const rotating = daemon.dispatch("device.rotate", { leaseId, orientation }, session);
      const outcome = expect(rotating).rejects.toMatchObject({ name: "UnknownLeaseError" });
      await vi.waitFor(() => expect(input.opens).toBe(5), { timeout: 10_000 });
      await daemon.dispatch("lease.release", { leaseId }, session);
      open();
      await outcome;
      await vi.waitFor(() => expect(input.opened[3]?.closes).toBe(1), { timeout: 10_000 });
      expect(input.opened[3]?.sent).toEqual([]);
    },
  );
  async function agentTokens(daemon: DaemonServer, labels: readonly string[]) {
    const admin: DispatchSession = { ...holder, principal: "operator", role: "admin" };
    return await Promise.all(
      labels.map(async (label) => {
        const created = await daemon.dispatch("token.create", { label, role: "agent" }, admin);
        return { principal: created.token.id, secret: created.secret };
      }),
    );
  }

  async function leaseFor(
    daemon: DaemonServer,
    principal: string,
    request: { readonly model: string; readonly platform: "ios" | "android" },
  ): Promise<string> {
    const granted = await daemon.dispatch("lease.request", request, { ...holder, principal });
    return (granted as { lease: { id: string } }).lease.id;
  }

  it(
    "an agent's POST /v1/leases/{id}/rotate answers 200 with the lease and orientation, or the refusal's status, on a worker and through a gateway",
    { timeout: 120_000 },
    async () => {
      const screen = { height: 2556, orientation: "portrait", width: 1179 } as const;

      async function exercise(
        daemon: DaemonServer,
        httpPort: number,
        input: FakeInputFactory,
        ready: () => Promise<void>,
        reclaimOnWorker?: (leaseId: string) => Promise<void>,
      ) {
        const [phone, emulator] = await agentTokens(daemon, ["phone", "emulator"]);
        const phoneId = await leaseFor(daemon, phone!.principal, {
          model: "iPhone 15",
          platform: "ios",
        });
        const emulatorId = await leaseFor(daemon, emulator!.principal, {
          model: "Pixel 8",
          platform: "android",
        });
        await ready();
        const rotate = async (leaseId: string, token: string, body: unknown) => {
          const url = `http://127.0.0.1:${String(httpPort)}/v1/leases/${leaseId}/rotate`;
          const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
          });
          const text = await response.text();
          return {
            body: (text.startsWith("{") ? JSON.parse(text) : {}) as {
              error?: Record<string, unknown>;
              leaseId?: string;
              orientation?: string;
            },
            status: response.status,
          };
        };
        const orientation = "landscape_left";

        expect(await rotate(phoneId, phone!.secret, { orientation })).toEqual({
          body: { leaseId: phoneId, orientation },
          status: 200,
        });
        expect(input.opened[0]?.sent).toEqual([{ kind: "orientation", orientation }]);

        for (const badOrientation of ["landscape-left", "auto", ""]) {
          const refused = await rotate(phoneId, phone!.secret, { orientation: badOrientation });
          expect([badOrientation, refused.status, refused.body.error?.code]).toEqual([
            badOrientation,
            400,
            "BAD_REQUEST",
          ]);
        }
        expect((await rotate(phoneId, phone!.secret, {})).status).toBe(400);

        const unknown = await rotate("nope", phone!.secret, { orientation });
        expect([unknown.status, unknown.body.error?.code]).toEqual([404, "UNKNOWN_LEASE"]);
        const foreign = await rotate(phoneId, emulator!.secret, { orientation });
        expect([foreign.status, foreign.body.error?.code]).toEqual([403, "FORBIDDEN"]);

        const android = await rotate(emulatorId, emulator!.secret, { orientation });
        expect(android.status).toBe(422);
        expect(android.body.error).toEqual({
          class: "emulator",
          code: "ROTATION_UNSUPPORTED",
          leaseId: emulatorId,
          physical: false,
          platform: "android",
          message: `Lease ${emulatorId} is on an Android emulator; only an iOS simulator can be rotated`,
        });

        input.failWith = new Error("helper is gone");
        const missing = await rotate(phoneId, phone!.secret, { orientation });
        expect(missing.status).toBe(503);
        expect(missing.body.error).toEqual({
          code: "INPUT_UNAVAILABLE",
          leaseId: phoneId,
          reason: "helper is gone",
          message: `Lease ${phoneId}'s simulator cannot take input: helper is gone`,
        });
        input.failWith = undefined;

        if (reclaimOnWorker !== undefined) {
          let open: () => void = () => undefined;
          input.gate = new Promise<void>((resolve) => {
            open = resolve;
          });
          const opensBefore = input.opens;
          const rotating = rotate(phoneId, phone!.secret, { orientation });
          await vi.waitFor(() => expect(input.opens).toBe(opensBefore + 1), { timeout: 10_000 });
          await reclaimOnWorker(phoneId);
          open();
          const gone = await rotating;
          expect([gone.status, gone.body.error?.code]).toEqual([404, "UNKNOWN_LEASE"]);
          expect(gone.body.error?.message).toBe(`Unknown lease: ${phoneId}`);
        }
      }

      const workerPort = await freeLoopbackPort();
      const workerInput = new FakeInputFactory(screen);
      const { daemon: standalone } = await startWorker({
        httpPort: workerPort,
        input: workerInput,
        inputModule: false,
      });
      await exercise(standalone, workerPort, workerInput, () => Promise.resolve());
      await daemons.pop()?.stop("test");

      const gatewayPort = await freeLoopbackPort();
      const admin: DispatchSession = { ...holder, principal: "operator", role: "admin" };
      const gatewayDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-rotate-gateway-"));
      directories.push(gatewayDirectory);
      const gateway = await startDaemon({
        configOverrides: { http: { enabled: true, host: "127.0.0.1", port: gatewayPort } },
        dataDirectory: gatewayDirectory,
        filesystem: new MemoryFilesystem(),
        logger: new NoopLogger(),
        role: "gateway",
        version: "1.0.0-e2e",
      });
      daemons.push(gateway);
      const workerToken = (
        await gateway.dispatch("token.create", { label: "w", role: "worker" }, admin)
      ).secret;
      const fleetInput = new FakeInputFactory(screen);
      const { daemon: fleetWorker } = await startWorker({
        gateway: { label: "w", token: workerToken, url: `ws://127.0.0.1:${String(gatewayPort)}` },
        input: fleetInput,
        inputModule: false,
      });
      await vi.waitFor(
        async () => {
          const { workers } = await gateway.dispatch("worker.list", {}, admin);
          expect(workers[0]?.catalog?.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      await exercise(
        gateway,
        gatewayPort,
        fleetInput,
        async () => {
          await vi.waitFor(
            async () => {
              const { leases } = await gateway.dispatch("lease.list", {}, admin);
              expect(leases).toHaveLength(2);
            },
            { timeout: 10_000 },
          );
        },
        async (leaseId) => {
          const { leases } = await gateway.dispatch("lease.list", {}, admin);
          const owner = leases.find((lease) => lease.id === leaseId)?.requesterId;
          const held = await fleetWorker.dispatch("lease.list", {}, admin);
          const workerLease = held.leases.find((lease) => lease.requesterId.endsWith(owner ?? ""));
          await fleetWorker.dispatch(
            "lease.release",
            { leaseId: workerLease?.id ?? "", requesterId: workerLease?.requesterId ?? "" },
            admin,
          );
        },
      );
    },
  );
});
