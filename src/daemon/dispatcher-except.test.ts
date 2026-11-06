import { describe, expect, it, vi } from "vitest";

import { readyTransitionUpdate } from "../core/testing.js";
import { DriverCrashError } from "../core/index.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

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

/** why: a slim device a worker already holds, ready or shut down, as the warm pool or an earlier lease leaves one. */
async function seedSlimDevice(
  built: Awaited<ReturnType<typeof buildDispatcher>>,
  state: "ready" | "shutdown",
) {
  const spec = {
    mode: "slim",
    model: "iPhone 17 Pro",
    osVersion: "26.5",
    physical: false,
    platform: "ios",
  } as const;
  const driverDevice = await built.driver.provision(spec);
  const ready = await built.driver.makeReady(driverDevice, { mode: "slim", purpose: "prepare" });
  const registered = await built.registry.registerDevice({
    driverData: driverDevice.driverData,
    driverDeviceId: driverDevice.deviceId,
    provisionDuration: 0,
    spec,
  });
  await built.registry.transitionDevice(
    registered.id,
    "ready",
    { event: "device.ready", payload: { bootDuration: 0, deviceId: registered.id } },
    readyTransitionUpdate(ready),
  );
  if (state === "ready") return registered;
  await built.driver.shutdown(driverDevice);
  await built.registry.transitionDevice(registered.id, "shutdown", {
    event: "device.shutdown",
    payload: { deviceId: registered.id, initiator: "test" },
  });
  return registered;
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
      ["a name the driver refuses", { ...ask, except: ["wallet"] }, ""],
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
