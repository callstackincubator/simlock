import { describe, expect, it } from "vitest";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: baseline.list", () => {
  it("lists the newest version of each baseline by name with its spec, note, size, saved time and stale reason, cleared when the runtime is back, and an agent may list", async () => {
    const { clock, dispatcher, driver, registry } = await buildDispatcher();
    const agent = session({ role: "agent" });
    const admin = session({ role: "admin" });
    expect(await dispatcher.dispatch("baseline.list", {}, agent)).toEqual({ baselines: [] });
    const save = async (name: string, content: string, note?: string): Promise<void> => {
      const grant = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        session(),
      );
      const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
      driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", content);
      await dispatcher.dispatch(
        "baseline.save",
        { leaseId: grant.lease.id, name, ...(note === undefined ? {} : { note }) },
        admin,
      );
    };
    await save("login", "signed in", "signed in");
    await save("checkout", "v1");
    await save("checkout", "version two");

    expect(await dispatcher.dispatch("baseline.list", {}, agent)).toEqual({
      baselines: [
        {
          mode: "full",
          model: "iPhone 17 Pro",
          name: "checkout",
          osVersion: "26.5",
          platform: "ios",
          savedAt: new Date(clock.now()).toISOString(),
          sizeBytes: "version two".length,
          version: 2,
        },
        {
          mode: "full",
          model: "iPhone 17 Pro",
          name: "login",
          note: "signed in",
          osVersion: "26.5",
          platform: "ios",
          savedAt: new Date(clock.now()).toISOString(),
          sizeBytes: "signed in".length,
          version: 1,
        },
      ],
    });

    const sources = await driver.listSources();
    const reason = "runtime com.apple.CoreSimulator.SimRuntime.iOS-26-5 is not installed";
    const staleNames = async (): Promise<(string | undefined)[]> =>
      (await dispatcher.dispatch("baseline.list", {}, agent)).baselines.map(
        (baseline) => baseline.staleReason,
      );
    const [loginSource] = sources;
    driver.setSources(
      sources.map((source) =>
        source === loginSource ? { ...source, staleReason: reason } : source,
      ),
    );
    expect(await staleNames()).toEqual([undefined, reason]);
    driver.setSources(sources);
    expect(await staleNames()).toEqual([undefined, undefined]);
  });
});

describe("Dispatcher: baseline.list without a driver", () => {
  it("lists a baseline whose platform has no driver as stale, without storing the reason or recording an event", async () => {
    const { dispatcher, eventBus } = await buildDispatcher({
      seedState: ({ database }) => {
        database
          .prepare(
            "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES ('droid', 1, 'android', 'Pixel 9', '36', 'full', '2026-11-02T13:40:00.000Z', 'src-droid')",
          )
          .run();
      },
    });
    const agent = session({ role: "agent" });

    const listed = await dispatcher.dispatch("baseline.list", {}, agent);
    expect(listed.baselines).toMatchObject([
      { name: "droid", staleReason: "the android driver is not available on this worker" },
    ]);
    expect(eventBus.replay().filter((envelope) => envelope.event === "baseline.stale")).toEqual([]);
  });
});

describe("Dispatcher: baselines beside a gateway's worker view", () => {
  it("answers worker.list with the baselines its own baseline.list gives, and with none when no baseline service is wired", async () => {
    const { dispatcher, driver, registry } = await buildDispatcher();
    const admin = session({ role: "admin" });
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const held = registry.snapshot.virtualDevices.find((device) => device.id === grant.device.id);
    driver.writeDeviceFile(held?.driverDeviceId ?? "", "data/state", "signed in");
    await dispatcher.dispatch("baseline.save", { leaseId: grant.lease.id, name: "login" }, admin);

    const { baselines } = await dispatcher.dispatch("baseline.list", {}, admin);
    const { workers } = await dispatcher.dispatch("worker.list", {}, admin);

    expect(baselines.map((baseline) => baseline.name)).toEqual(["login"]);
    expect(workers[0]?.baselines).toEqual(baselines);

    const bare = await buildDispatcher({ withoutBaselines: true });
    const listed = await bare.dispatcher.dispatch("worker.list", {}, admin);
    expect(listed.workers[0]).not.toHaveProperty("baselines");
  });

  it("refuses baseline.remove with a workerId, which names a gateway's worker", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch(
        "baseline.remove",
        { name: "login", workerId: "wrk_a" },
        session({ role: "admin" }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "workerId names a gateway's worker, and this daemon is not a gateway; remove without --worker",
    });
  });
});
