import { describe, expect, it, vi } from "vitest";

import { DriverCrashError } from "../core/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, seedSlimDevice, session } from "./test-dispatcher.js";

/** why: the answer of a request that must settle by itself once the event loop has run to rest; a hang fails here, on a named assertion, rather than by the test's timeout. */
async function grantedOnceSettled<T>(request: Promise<T>): Promise<T> {
  const rest = (async () => {
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    return undefined;
  })();
  const answer = await Promise.race([request, rest]);
  expect(answer, "the request settled").toBeDefined();
  return answer as T;
}

describe("Dispatcher: lease.request with an except list", () => {
  it("a client leases slim with except and is granted a device reporting it", async () => {
    const except = ["store", "other"];
    const ask = { model: "iPhone 17 Pro", platform: "ios", mode: "slim", except } as const;

    const slimmed = await buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });
    const granted = await slimmed.dispatcher.dispatch(
      "lease.request",
      { ...ask, osVersion: "26.5" },
      session(),
    );
    const listed = await slimmed.dispatcher.dispatch(
      "list.get",
      { kind: "devices" },
      session({ role: "admin" }),
    );
    const status = await slimmed.dispatcher.dispatch("status.get", {}, session());
    expect(granted.device).toMatchObject({ except, mode: "slim" });
    expect(
      slimmed.driver.calls.find((call) => call.operation === "makeReady")?.arguments[1],
    ).toMatchObject({ except, mode: "slim", purpose: "prepare" });
    expect(
      (listed as { id: string; except?: string[] }[]).find((d) => d.id === granted.device.id),
    ).toMatchObject({ except });
    expect(status.devices?.find((d) => d.id === granted.device.id)).toMatchObject({ except });
    expect(
      slimmed.eventBus.replay().find((event) => event.event === "lease.requested")?.payload,
    ).toMatchObject({ requestSpec: { except } });

    const warm = await buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });
    const registered = await seedSlimDevice(warm, "ready");
    const seededCalls = warm.driver.calls.length;
    const grantedWarm = await warm.dispatcher.dispatch(
      "lease.request",
      { ...ask, osVersion: "26.5" },
      session(),
    );
    expect(grantedWarm.device).toMatchObject({ except, id: registered.id, mode: "slim" });
    // why: the seed's boot was the device's first, so the reboot's address is the second boot's.
    expect(grantedWarm.device.address).toBe(`${registered.driverDeviceId}-addr-2`);
    expect(
      warm.driver.calls
        .slice(seededCalls)
        .filter((call) => call.operation === "shutdown" || call.operation === "makeReady")
        .map((call) => call.operation),
    ).toEqual(["shutdown", "makeReady"]);
    expect(
      warm.driver.calls.slice(seededCalls).find((call) => call.operation === "makeReady")
        ?.arguments[1],
    ).toMatchObject({ except, mode: "slim", purpose: "prepare" });
    expect(
      warm.eventBus.replay().find((event) => event.event === "lease.granted")?.payload,
    ).toMatchObject({ source: "booted" });

    const full = await buildDispatcher({
      driverOptions: { availableOsVersions: ["18.4", "26.5"], slimmableOsVersions: ["26.5"] },
    });
    const grantedFull = await full.dispatcher.dispatch(
      "lease.request",
      { ...ask, osVersion: "18.4" },
      session(),
    );
    expect(grantedFull.device.mode).toBe("full");
    expect(grantedFull.device).not.toHaveProperty("except");
    expect(
      full.driver.calls.find((call) => call.operation === "makeReady")?.arguments[1],
    ).not.toHaveProperty("except");
  });

  it("a client's except request is refused with BAD_REQUEST and the reason, and a slim baseline on a full-default worker is granted", async () => {
    const ask = {
      except: ["store"],
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const { mode: _mode, ...noMode } = ask;
    const driverOptions = { slimCategories: ["store", "other"], slimmableOsVersions: ["26.5"] };
    const attempt = async (input: unknown, defaultMode: "slim" | "full" = "slim") => {
      const built = await buildDispatcher({
        driverOptions,
        engine: { defaultModes: { ios: defaultMode } },
      });
      return built.dispatcher.dispatch("lease.request", input as never, session()).then(
        () => undefined,
        (error: unknown) => error,
      );
    };

    expect(await attempt(ask)).toBeUndefined();
    const refusals: readonly [string, unknown, string, ("slim" | "full")?][] = [
      ["duplicate", { ...ask, except: ["store", "store"] }, 'except names "store" twice'],
      ["bad characters", { ...ask, except: ["Store"] }, 'except: "Store" is not a category name'],
      ["none named", { ...ask, except: [] }, "except names 1 to 16 categories"],
      [
        "too many",
        { ...ask, except: Array.from({ length: 17 }, (_, index) => `c${index}`) },
        "except names 1 to 16 categories",
      ],
      ["mode full", { ...ask, mode: "full" }, "except needs a slim lease (mode is full)"],
      [
        "default full",
        noMode,
        "except needs a slim lease (this worker's default mode is full)",
        "full",
      ],
      ["physical", { ...ask, physical: true }, "except is for iOS simulators"],
      ["android", { ...ask, platform: "android" }, "except is for iOS simulators"],
      [
        "a name the driver refuses",
        { ...ask, except: ["wallet"] },
        'unknown slim category "wallet"',
      ],
    ];
    for (const [label, input, message, defaultMode] of refusals) {
      const error = await attempt(input, defaultMode);
      expect(classifyError(error), label).toBe("BAD_REQUEST");
      expect((error as Error).message, label).toContain(message);
    }

    const { dispatcher } = await buildDispatcher({
      driverOptions,
      engine: { defaultModes: { ios: "full" } },
    });
    const save = async (name: string, mode: "slim" | "full", principal: string) => {
      const lease = await dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", mode, osVersion: "26.5", platform: "ios" },
        session({ principal }),
      );
      await dispatcher.dispatch(
        "baseline.save",
        { leaseId: lease.lease.id, name },
        session({ principal, role: "admin" }),
      );
    };
    await save("slim-base", "slim", "tok_a");
    await save("full-base", "full", "tok_b");
    const fromFull = await dispatcher
      .dispatch(
        "lease.request",
        { baseline: "full-base", except: ["store"], platform: "ios" },
        session({ principal: "tok_c" }),
      )
      .catch((error: unknown) => error);
    expect(classifyError(fromFull)).toBe("BAD_REQUEST");
    expect((fromFull as Error).message).toContain(
      'except needs a slim lease (baseline "full-base" is full)',
    );
    const fromSlim = await dispatcher.dispatch(
      "lease.request",
      { baseline: "slim-base", except: ["store"], platform: "ios" },
      session({ principal: "tok_d" }),
    );
    expect(fromSlim.device).toMatchObject({ except: ["store"], mode: "slim" });
    const unknownFromSlim = await dispatcher
      .dispatch(
        "lease.request",
        { baseline: "slim-base", except: ["wallet"], platform: "ios" },
        session({ principal: "tok_e" }),
      )
      .catch((error: unknown) => error);
    expect(classifyError(unknownFromSlim)).toBe("BAD_REQUEST");
    expect((unknownFromSlim as Error).message).toContain('unknown slim category "wallet"');
  });

  it("a slim except boot the driver grants full leaves the device full with no except, on a reboot and on a boot", async () => {
    const ask = {
      except: ["store"],
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const build = () =>
      buildDispatcher({ driverOptions: { mode: "full", slimmableOsVersions: ["26.5"] } });

    for (const state of ["ready", "shutdown"] as const) {
      const built = await build();
      const seeded = await seedSlimDevice(built, state);
      const granted = await built.dispatcher.dispatch("lease.request", ask, session());

      expect(granted.device.id, state).toBe(seeded.id);
      expect(granted.device, state).not.toHaveProperty("except");
      const record = built.registry.snapshot.devices.find((d) => d.id === seeded.id);
      expect(record, state).toMatchObject({ mode: "full", state: "leased" });
      expect(record, state).not.toHaveProperty("except");
    }
  });

  it("a failed except boot is never granted", async () => {
    const ask = {
      except: ["store"],
      mode: "slim",
      model: "iPhone 17 Pro",
      osVersion: "26.5",
      platform: "ios",
    } as const;
    const crash = new DriverCrashError("simulator never booted");
    const build = () => buildDispatcher({ driverOptions: { slimmableOsVersions: ["26.5"] } });

    const prepareFails = await build();
    const seededPrepare = await seedSlimDevice(prepareFails, "ready");
    // why: call 1 of makeReady is the seed's own boot; the reboot is call 2.
    prepareFails.driver.failOn("makeReady", 2, crash);
    const afterPrepare = await grantedOnceSettled(
      prepareFails.dispatcher.dispatch("lease.request", ask, session()),
    );
    expect(afterPrepare.device.id).not.toBe(seededPrepare.id);
    expect(afterPrepare.device).toMatchObject({ except: ask.except, mode: "slim" });
    expect(
      prepareFails.registry.snapshot.devices.find((d) => d.id === seededPrepare.id)?.state,
    ).toBe("deleted");
    expect(
      prepareFails.eventBus
        .replay()
        .filter((event) => event.event === "lease.granted")
        .map((event) => (event.payload as { deviceId: string }).deviceId),
    ).toEqual([afterPrepare.device.id]);

    const shutdownFails = await build();
    const seededShutdown = await seedSlimDevice(shutdownFails, "ready");
    shutdownFails.driver.failOn("shutdown", 1, crash);
    const afterShutdown = await grantedOnceSettled(
      shutdownFails.dispatcher.dispatch("lease.request", ask, session()),
    );
    expect(afterShutdown.device.id).not.toBe(seededShutdown.id);
    expect(
      shutdownFails.registry.snapshot.devices.find((d) => d.id === seededShutdown.id)?.state,
    ).toBe("deleted");
    expect(
      shutdownFails.eventBus
        .replay()
        .filter((event) => event.event === "device.shutdown")
        .map((event) => event.payload),
    ).toContainEqual({ deviceId: seededShutdown.id, initiator: "lease-engine" });

    const booting = await build();
    const seededShut = await seedSlimDevice(booting, "shutdown");
    const bootedShut = await booting.dispatcher.dispatch("lease.request", ask, session());
    expect(bootedShut.device).toMatchObject({ except: ask.except, id: seededShut.id });
    expect(
      booting.driver.calls.filter((call) => call.operation === "makeReady").at(-1)?.arguments[1],
    ).toMatchObject({ except: ask.except, purpose: "prepare" });
    expect(
      booting.eventBus.replay().find((event) => event.event === "lease.granted")?.payload,
    ).toMatchObject({ source: "booted" });

    const bootFails = await build();
    const seededBootFails = await seedSlimDevice(bootFails, "shutdown");
    bootFails.driver.failOn("makeReady", 2, crash);
    const afterBoot = await grantedOnceSettled(
      bootFails.dispatcher.dispatch("lease.request", ask, session()),
    );
    expect(afterBoot.device.id).not.toBe(seededBootFails.id);
    expect(
      bootFails.registry.snapshot.devices.find((d) => d.id === seededBootFails.id)?.state,
    ).toBe("deleted");

    const twice = await build();
    twice.driver.failOn("provision", 1, crash);
    twice.driver.failOn("makeReady", 1, crash);
    const refusal = await twice.dispatcher
      .dispatch("lease.request", ask, session())
      .catch((error: unknown) => error);
    expect(classifyError(refusal)).toBe("PROVISION_FAILED");

    const replay = await build();
    const keyed = { ...ask, idempotencyKey: "key-1" };
    const first = await replay.dispatcher.dispatch("lease.request", keyed, session());
    const same = await replay.dispatcher.dispatch("lease.request", keyed, session());
    expect(same.lease.id).toBe(first.lease.id);
    const conflict = await replay.dispatcher
      .dispatch("lease.request", { ...keyed, except: ["other"] }, session())
      .catch((error: unknown) => error);
    expect(classifyError(conflict)).toBe("IDEMPOTENCY_CONFLICT");

    // why: each failed boot or reboot counts toward the one retry, so a provision failure after it is the second.
    for (const state of ["ready", "shutdown"] as const) {
      const counted = await build();
      await seedSlimDevice(counted, state);
      // why: call 1 of makeReady and of provision is the seed's own; call 2 of each is the waiter's.
      counted.driver.failOn("makeReady", 2, crash);
      counted.driver.failOn("provision", 2, crash);
      const countedRefusal = await grantedOnceSettled(
        counted.dispatcher.dispatch("lease.request", ask, session()).then(
          () => undefined,
          (error: unknown) => error ?? "granted",
        ),
      );
      expect(classifyError(countedRefusal), state).toBe("PROVISION_FAILED");
    }

    // why: a worker with one running slot is granted after a failed boot only when that boot released the slot it reserved.
    const oneSlot = await buildDispatcher({
      capacity: {
        config: {
          limits: {
            android: { maxDevices: 1, maxRunning: 1 },
            ios: { maxDevices: 1, maxRunning: 1 },
            maxRunning: 1,
          },
          ramBudget: { androidBytesPerDevice: 4 * 1024 ** 3, iosBytesPerDevice: 1024 ** 3 },
        },
        strategy: "resource",
      },
      driverOptions: { slimmableOsVersions: ["26.5"] },
    });
    await seedSlimDevice(oneSlot, "shutdown");
    oneSlot.driver.failOn("makeReady", 2, crash);
    const afterOneSlot = await grantedOnceSettled(
      oneSlot.dispatcher.dispatch("lease.request", ask, session()),
    );
    expect(afterOneSlot.device).toMatchObject({ except: ask.except, mode: "slim" });

    const rebooting = await build();
    const seededWarm = await seedSlimDevice(rebooting, "ready");
    const before = (await rebooting.dispatcher.dispatch("status.get", {}, session())).capacity;
    rebooting.driver.hangMakeReady();
    const pending = rebooting.dispatcher.dispatch("lease.request", ask, session());
    await vi.waitFor(() => {
      expect(rebooting.driver.calls.filter((call) => call.operation === "makeReady")).toHaveLength(
        2,
      );
    });
    const during = await rebooting.dispatcher.dispatch("status.get", {}, session());
    expect(during.devices?.find((d) => d.id === seededWarm.id)?.state).toBe("ready");
    expect(during.capacity).toEqual(before);
    rebooting.driver.releaseMakeReady();
    expect((await pending).device.id).toBe(seededWarm.id);
  });
});
