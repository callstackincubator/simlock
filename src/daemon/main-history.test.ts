import { hasEvent, historyEventsWhen } from "./test-main-history.js";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedHistory } from "../history/testing.js";
import { start, stopDaemons, temporaryDirectories, writeModule } from "./test-main.js";

afterEach(stopDaemons);

describe("the event history", () => {
  it("prunes at start by the configured eventLog.retention, so an event older than it on the injected clock is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-"));
    temporaryDirectories.push(directory);
    // why: the fake clock reads 1_000; with a retention of 100 the cutoff is 900, past 500 and before 950.
    await seedHistory(directory, [500, 950]);

    await start({ configOverrides: { eventLog: { retention: 100 } }, dataDirectory: directory });

    const events = await historyEventsWhen(directory, hasEvent("daemon.started"));
    expect(events.map((event) => event.id)).not.toContain("evt_1");
    expect(events.map((event) => event.id)).toContain("evt_2");
  });
});

describe("startDaemon event history", () => {
  const previousModule = process.env.SIMLOCK_DRIVERS_MODULE;

  afterEach(() => {
    if (previousModule === undefined) {
      delete process.env.SIMLOCK_DRIVERS_MODULE;
    } else {
      process.env.SIMLOCK_DRIVERS_MODULE = previousModule;
    }
  });

  it("starts a daemon whose history path is a directory, sets it aside and writes a fresh file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "history.db"));

    const { daemon } = await start({ dataDirectory: directory });

    const events = await historyEventsWhen(directory, hasEvent("daemon.started"));
    const names = await readdir(directory);
    const status = (await daemon.dispatch(
      "status.get",
      {},
      {
        manageEventSubscription: () => undefined,
        principal: "operator",
        role: "admin",
        via: "socket",
      },
    )) as { readonly history?: unknown };
    expect(daemon.health).toBe("running");
    expect(names).toContain("history.db.damaged-1000");
    expect((await stat(join(directory, "history.db.damaged-1000"))).isDirectory()).toBe(true);
    expect((await stat(join(directory, "history.db"))).isFile()).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(status.history).toEqual({ opened: true, setAsideAt: 1_000, writing: true });
  });

  it("a daemon that loses the socket claim leaves a damaged history.db byte-identical and in place", async () => {
    const winner = await mkdtemp(join(tmpdir(), "simlock-main-claim-"));
    const loser = await mkdtemp(join(tmpdir(), "simlock-main-claim-"));
    temporaryDirectories.push(winner, loser);
    const junk = "this is not a sqlite database ".repeat(20);
    await writeFile(join(loser, "history.db"), junk);
    const socketPath = join(winner, "daemon.sock");
    await start({ dataDirectory: winner, socketPath });

    const outcome = await start({ dataDirectory: loser, socketPath }).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );

    expect(outcome).toBe("rejected");
    expect(
      await readdir(loser).then((names) => names.filter((name) => name.startsWith("history"))),
    ).toEqual(["history.db"]);
    expect(await readFile(join(loser, "history.db"), "utf8")).toBe(junk);
  });

  it("mints event ids from the idGenerator the daemon was given", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers({ eventBus }) {
         eventBus.emit("component.installed", { componentId: "18.6", durationMs: 1, platform: "ios" }, "test");
         return [];
       }`,
    );

    await start({
      dataDirectory: directory,
      drivers: undefined,
      idGenerator: { generate: () => "from-the-given-generator" },
    });

    const ids = (
      await historyEventsWhen(directory, (events) =>
        events.some((event) => event.id === "evt_from-the-given-generator"),
      )
    ).map((event) => event.id);
    expect(ids).toContain("evt_from-the-given-generator");
  });

  it("keeps component.installed and device.slimmed in the event history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-event-file-"));
    temporaryDirectories.push(directory);
    process.env.SIMLOCK_DRIVERS_MODULE = await writeModule(
      `export function createDrivers({ eventBus }) {
         eventBus.emit("component.installed", { componentId: "18.6", durationMs: 1, platform: "ios" }, "test");
         eventBus.emit("device.slimmed", {
           address: "a", categories: [], deviceId: "d", durationMs: 1, labelCount: 0,
           platform: "ios", signature: "s", unknownLabels: [],
         }, "test");
         return [];
       }`,
    );

    await start({ dataDirectory: directory, drivers: undefined });

    const written = (await historyEventsWhen(directory, hasEvent("device.slimmed"))).map(
      (event) => event.event,
    );
    expect(written).toEqual(expect.arrayContaining(["component.installed", "device.slimmed"]));
  });
});
