import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import type { OptionalModuleDefinition, WorkerHooks } from "../modules/index.js";
import { fakeModule, type FakeModule } from "../modules/testing.js";
import {
  FakeClock,
  IpcError,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { startDaemon, type StartDaemonOptions } from "./main.js";
import type { DaemonServer } from "./server.js";
import { settleWithin } from "./test-relay-support.js";
import {
  admin,
  daemons,
  definitions,
  directories,
  leaseAndRelease,
  prepare,
  servers,
  sleep,
  start,
} from "./test-optional-modules.js";

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test").catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

// why: a value no default uses, so a timer with it is the lease-end wait ceiling a participant arms.
const END_WAIT_MS = 7_777;

describe("optional modules: a start that cannot go on", () => {
  const cases: readonly {
    readonly title: string;
    readonly good: () => FakeModule[];
    readonly bad: () => FakeModule[];
    readonly names: readonly string[];
    readonly overrides?: Record<string, unknown>;
  }[] = [
    {
      bad: () => [fakeModule({ capabilityName: "beta", name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" })],
      names: ["alpha", "beta"],
      title: "a capability name that differs from the definition's",
    },
    {
      bad: () => [fakeModule({ name: "alpha" }), fakeModule({ name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" }), fakeModule({ name: "bravo" })],
      names: ["alpha"],
      title: "two definitions with one name",
    },
    {
      bad: () => [fakeModule({ name: "agent-device" }), fakeModule({ name: "agent-device" })],
      good: () => [fakeModule({ name: "agent-device" }), fakeModule({ name: "agent-devices" })],
      names: ["agent-device"],
      title: "two definitions named agent-device",
    },
    {
      bad: () => [fakeModule({ name: "Bad_Name" })],
      good: () => [fakeModule({ name: "good-name" })],
      names: ["Bad_Name"],
      title: "a name that fails the capability name check",
    },
    {
      bad: () => Array.from({ length: 17 }, (_, i) => fakeModule({ name: `mod-${String(i)}` })),
      good: () => Array.from({ length: 16 }, (_, i) => fakeModule({ name: `mod-${String(i)}` })),
      names: ["mod-16", "17"],
      title: "17 fake modules (17 capabilities)",
    },
    {
      bad: () => [fakeModule({ loadError: new Error("no such file"), name: "alpha" })],
      good: () => [fakeModule({ name: "alpha" })],
      names: ["alpha", "no such file"],
      title: "a loadWorker() that throws",
    },
  ];

  it.each(cases)("the start fails, naming the module, for $title", async ({ bad, good, names }) => {
    const turnOn = (modules: FakeModule[]) => modules.map((m) => m.definition.name);
    const goodModules = good();
    await start({ modules: definitions(...goodModules), on: turnOn(goodModules) });

    const failure = await start({ modules: definitions(...bad()), on: turnOn(bad()) }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    for (const name of names) expect(failure?.message).toContain(name);
  });

  it("a module that calls ctx.cancelPending in createWorker fails the start, naming the module", async () => {
    const quiet = fakeModule({ name: "alpha" });
    await start({ modules: definitions(quiet), on: ["alpha"] });

    const failure = await start({
      modules: definitions(
        fakeModule({ name: "alpha", onCreate: (ctx) => void ctx.cancelPending("agent-1") }),
      ),
      on: ["alpha"],
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("alpha");
    expect(failure?.message).toContain("leasing is not ready yet");
  });

  it("when the second of two modules throws in createWorker, the first module's afterSocketClaimed never runs", async () => {
    const claimed = vi.fn();
    const first = fakeModule({ hooks: { afterSocketClaimed: claimed }, name: "alpha" });
    const failure = await start({
      modules: definitions(
        first,
        fakeModule({
          name: "bravo",
          onCreate: () => {
            throw new Error("bravo broke");
          },
        }),
      ),
      on: ["alpha", "bravo"],
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    await sleep(50);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("bravo");
    expect({ claimed: claimed.mock.calls.length, created: first.creates }).toEqual({
      claimed: 0,
      created: 1,
    });
  });

  it("when the HTTP gateway fails to bind after the socket is claimed, the daemon stops and each started module's beforeDrain and beforeDriversDispose run", async () => {
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as { port: number };
    const notes: string[] = [];
    const hooks: WorkerHooks = {
      beforeDrain: () => {
        notes.push("drain");
        return Promise.resolve();
      },
      beforeDriversDispose: () => {
        notes.push("dispose");
        return Promise.resolve();
      },
    };

    const outcome = await prepare({
      modules: definitions(fakeModule({ hooks, name: "alpha" })),
      notes,
      on: ["alpha"],
      overrides: { http: { enabled: true, host: "127.0.0.1", port } },
    }).then((prepared) =>
      startDaemon(prepared.startOptions).then(
        () => "started",
        () => "rejected",
      ),
    );
    await vi.waitFor(() => expect(notes).toContain("dispose"));

    expect(outcome).toBe("rejected");
    expect(notes.filter((note) => note === "drain" || note === "dispose")).toEqual([
      "drain",
      "dispose",
    ]);
  });
});

describe("optional modules: afterSocketClaimed", () => {
  it("runs once after the socket is claimed, and the start does not wait for it", async () => {
    let socketPath = "";
    const seen: boolean[] = [];
    const never = new Promise<void>(() => undefined);
    const prepared = await prepare({
      modules: definitions(
        fakeModule({
          hooks: {
            afterSocketClaimed: () => {
              seen.push(existsSync(socketPath));
              return never;
            },
          },
          name: "alpha",
        }),
      ),
      on: ["alpha"],
    });
    socketPath = join(prepared.directory, "daemon.sock");

    const started = await settleWithin(startDaemon(prepared.startOptions), 5_000);
    if (started.state === "fulfilled") daemons.push(started.value);
    await sleep(50);

    expect(started.state).toBe("fulfilled");
    expect(seen).toEqual([true]);
  });

  it.each([
    // why: the loser refuses at the probe, before it opens state.db, so it builds no module at all
    ["at the probe", undefined, 0],
    // why: the loser's probe finds nothing answering, then its claim finds the address taken
    [
      "at the claim",
      {
        connect: () =>
          Promise.reject(new IpcError("endpoint-not-found", "nothing answers", undefined)),
        listen: () => Promise.reject(new IpcError("address-in-use", "address taken", undefined)),
      } as StartDaemonOptions["ipc"],
      1,
    ],
  ] as const)(
    "never runs in a daemon that lost the socket race %s",
    async (_where, loserIpc, created) => {
      const claimed = vi.fn();
      const filesystem = new MemoryFilesystem();
      const directory = await mkdtemp(join(tmpdir(), "simlock-modules-race-"));
      directories.push(directory);
      const options = (
        modules: readonly OptionalModuleDefinition<unknown>[],
        ipc?: StartDaemonOptions["ipc"],
      ) =>
        ({
          clock: new FakeClock(1_000),
          configOverrides: { capabilities: { alpha: { enabled: true } }, http: { enabled: false } },
          dataDirectory: directory,
          drivers: [
            new FakeDriver({
              availableOsVersions: ["26.5"],
              clock: new FakeClock(1_000),
              platform: "ios",
            }),
          ],
          filesystem,
          ...(ipc === undefined ? {} : { ipc }),
          logger: new JsonLinesLogger({
            clock: new FakeClock(1_000),
            level: "debug",
            sink: new MemoryLogSink(),
          }),
          optionalModules: modules,
          deviceDataTables: fakeDeviceDataTables,
          version: "1.2.3",
        }) as StartDaemonOptions;
      const first = await startDaemon(options([]));
      daemons.push(first);

      const loser = fakeModule({ hooks: { afterSocketClaimed: claimed }, name: "alpha" });
      const second = await startDaemon(options(definitions(loser), loserIpc)).then(
        () => "started",
        () => "rejected",
      );
      await sleep(50);

      expect({ claimed: claimed.mock.calls.length, created: loser.creates, second }).toEqual({
        claimed: 0,
        created,
        second: "rejected",
      });
    },
  );

  it.each([
    [
      "throws",
      () => {
        throw new Error("hook broke");
      },
    ],
    ["rejects", () => Promise.reject(new Error("hook broke"))],
  ] as const)(
    "an afterSocketClaimed that %s does not stop the daemon starting",
    async (_how, hook) => {
      const claimed = vi.fn(hook);
      const { daemon } = await start({
        modules: definitions(fakeModule({ hooks: { afterSocketClaimed: claimed }, name: "alpha" })),
        on: ["alpha"],
      });

      await vi.waitFor(() => expect(claimed).toHaveBeenCalledTimes(1));
      expect(daemon.health).toBe("running");
    },
  );
});

describe("optional modules: beforeDeviceReclaim", () => {
  it("a release destroys the device when no turned-on module has beforeDeviceReclaim", async () => {
    const notes: string[] = [];
    const { daemon } = await start({
      modules: definitions(fakeModule({ name: "alpha" })),
      notes,
      on: ["alpha"],
      overrides: { lease: { endWaitMs: END_WAIT_MS } },
    });

    await leaseAndRelease(daemon);

    await vi.waitFor(() => expect(notes).toContain("driver destroy"));
  });

  it("beforeDeviceReclaim runs after a release commits and before the device's destroy starts", async () => {
    const notes: string[] = [];
    let live: DaemonServer | undefined;
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDeviceReclaim: async (lease) => {
              const listed = (await live?.dispatch("lease.list", {}, admin)) as {
                leases: { id: string }[];
              };
              notes.push(
                listed.leases.some((entry) => entry.id === lease.leaseId)
                  ? "lease still listed"
                  : "lease gone",
              );
              await sleep(30);
              notes.push("hook done");
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
      overrides: { lease: { endWaitMs: END_WAIT_MS } },
    });
    live = daemon;

    await leaseAndRelease(daemon);
    await vi.waitFor(() => expect(notes).toContain("driver destroy"));

    expect(notes).toEqual(["lease gone", "hook done", "driver destroy"]);
  });
});
