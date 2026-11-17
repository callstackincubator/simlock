import { describe, expect, it, vi } from "vitest";
import { FakeDriver, type FakeDriverOptions } from "../core/testing.js";
import { RuntimeMissingError } from "../core/index.js";
import { OPERATIONS } from "../contract/index.js";
import type { DispatchSession } from "./dispatcher.js";
import { DispatchError } from "./dispatcher.js";
import { classifyError } from "./error-code.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

describe("Dispatcher: image tags", () => {
  const androidImages: Partial<FakeDriverOptions> = {
    availableOsVersions: ["34", "35"],
    images: [
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
    ],
    platform: "android",
  };

  it("grants a request naming an installed tag a device whose spec shows the tag, and one naming none a spec without it", async () => {
    const tagged = await (
      await buildDispatcher({ driverOptions: androidImages })
    ).dispatcher.dispatch(
      "lease.request",
      {
        imageTag: "google_apis_playstore",
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
        requesterId: "tagged",
      },
      session(),
    );
    const untagged = await (
      await buildDispatcher({ driverOptions: androidImages })
    ).dispatcher.dispatch(
      "lease.request",
      {
        model: "Pixel 8",
        osVersion: "34",
        platform: "android",
        requesterId: "untagged",
      },
      session(),
    );

    expect(tagged.device.spec).toEqual({
      imageTag: "google_apis_playstore",
      model: "Pixel 8",
      osVersion: "34",
      physical: false,
      platform: "android",
    });
    expect(untagged.device.spec).toEqual({
      model: "Pixel 8",
      osVersion: "34",
      physical: false,
      platform: "android",
    });
  });

  it("answers RUNTIME_MISSING for a tag not installed for the API level, even with allowDownload under downloads.policy 'always', and starts no install", async () => {
    const asked: unknown[] = [];
    const { dispatcher } = await buildDispatcher({
      components: {
        claimProvision: () => () => undefined,
        inProgress: () => [],
        install: async (call) => {
          asked.push(call);
          return { outcome: "installed", version: "35" };
        },
        list: async () => [],
        remove: () => Promise.reject(new Error("unreachable")),
      },
      downloadsPolicy: "always",
      driverOptions: androidImages,
    });

    const error = await dispatcher
      .dispatch(
        "lease.request",
        {
          allowDownload: true,
          imageTag: "google_apis_playstore",
          model: "Pixel 8",
          osVersion: "35",
          platform: "android",
        },
        session(),
      )
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("RUNTIME_MISSING");
    expect(asked).toEqual([]);
  });

  it.each([
    ["a character outside letters, digits, '_', '.' and '-'", "google apis"],
    ["more than 64 characters", "a".repeat(65)],
    ["no characters", ""],
  ])("refuses a tag with %s as BAD_REQUEST before any driver sees it", async (_label, imageTag) => {
    const { dispatcher, driver } = await buildDispatcher({ driverOptions: androidImages });

    const error = await dispatcher
      .dispatch("lease.request", { imageTag, model: "Pixel 8", platform: "android" }, session())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("BAD_REQUEST");
    expect(driver.calls).toEqual([]);
  });
});

describe("Dispatcher: the download policy clamp applies regardless of caller", () => {
  it("starts no install for allowDownload:true when downloads.policy is 'never'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "never" });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        {
          allowDownload: true,
          model: "iPhone 17 Pro",
          osVersion: "27.0",
          platform: "ios",
        },
        session(),
      ),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
    expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");
  });

  it("catalog.get keeps a custom model whose name is too long for the mark listed, without the mark, in an answer the contract accepts", async () => {
    const long = "x".repeat(300);
    const { dispatcher } = await buildDispatcher({
      driverOptions: { customModels: [long, "My Tablet"], knownModels: [long, "My Tablet"] },
    });

    const catalog = await dispatcher.dispatch("catalog.get", {}, session());

    expect(() => OPERATIONS["catalog.get"].output.parse(catalog)).not.toThrow();
    expect(catalog.platforms[0]?.models).toEqual([long, "My Tablet"]);
    expect(catalog.platforms[0]?.customModels).toEqual(["My Tablet"]);
  });

  it.each(["never", "on-request", "always"] as const)(
    "catalog.get lists exactly the images the driver finds installed under downloads.policy '%s'",
    async (downloadsPolicy) => {
      const installed = [{ abi: "arm64-v8a", runtime: "26.5", tag: "default" }];
      const { dispatcher, driver } = await buildDispatcher({
        downloadsPolicy,
        driverOptions: { images: installed, knownModels: ["iPhone 17 Pro"] },
      });

      const catalog = await dispatcher.dispatch("catalog.get", {}, session());

      expect(catalog.platforms[0]?.images).toEqual(installed);
      // why: only what is on the machine is listed, however much of the rest a policy would download.
      expect(catalog.platforms[0]?.runtimes).toEqual(["26.5"]);
      expect(catalog.platforms[0]?.modelRuntimes).toEqual({ "iPhone 17 Pro": ["26.5"] });
      const listCalls = driver.calls.filter((call) => call.operation === "listCatalog");
      expect(listCalls.map((call) => call.arguments)).toEqual([[]]);
    },
  );

  it("installs for allowDownload:true when downloads.policy is 'on-request'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });
    await dispatcher.dispatch(
      "lease.request",
      {
        allowDownload: true,
        model: "iPhone 17 Pro",
        osVersion: "27.0",
        platform: "ios",
      },
      session(),
    );
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["27.0"]]);
  });
});

describe("Dispatcher: component.install", () => {
  const admin = (overrides: Partial<DispatchSession> = {}) =>
    session({ principal: "tok_operator", role: "admin", ...overrides });

  function spyInstaller() {
    const install = vi.fn(() =>
      Promise.resolve({ outcome: "installed" as const, version: "unreachable" }),
    );
    return {
      claimProvision: () => () => undefined,
      inProgress: () => [],
      install,
      list: () => Promise.resolve([]),
      remove: vi.fn(() => Promise.reject(new Error("unreachable"))),
    };
  }

  function installCalls(driver: FakeDriver): unknown[] {
    return driver.calls
      .filter((call) => call.operation === "installComponent")
      .map((call) => call.arguments);
  }

  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`never happened: ${label}`);
  }

  it("calls the installer for a missing component and answers installed with the version", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const result = await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );

    expect(result).toEqual({
      component: "27.0",
      outcome: "installed",
      platform: "ios",
      version: "27.0",
    });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("answers already-installed for an installed component and starts no install", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const result = await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "26.5" },
      admin(),
    );

    expect(result).toEqual({
      component: "26.5",
      outcome: "already-installed",
      platform: "ios",
      version: "26.5",
    });
    expect(installCalls(driver)).toEqual([]);
  });

  it("refuses an agent session with FORBIDDEN and never calls the installer", async () => {
    const components = spyInstaller();
    const { dispatcher } = await buildDispatcher({ components });

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(components.install).not.toHaveBeenCalled();
  });

  it("fails with DOWNLOADS_DISABLED under downloads.policy 'never' and never calls the installer", async () => {
    const components = spyInstaller();
    const { dispatcher } = await buildDispatcher({ components, downloadsPolicy: "never" });

    const error = await dispatcher
      .dispatch("component.install", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchError);
    expect(error).toMatchObject({ code: "DOWNLOADS_DISABLED", details: { policy: "never" } });
    expect(components.install).not.toHaveBeenCalled();
  });

  it("installs under downloads.policy 'on-request' with no flag of its own", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin()),
    ).resolves.toMatchObject({ outcome: "installed" });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("joins a lease request's download of the same component: one install, and both succeed", async () => {
    const { components, dispatcher, driver } = await buildDispatcher({
      driverOptions: { knownModels: ["iPhone 17 Pro"] },
    });
    const installerCalls = vi.spyOn(components, "install");
    driver.holdInstalls();

    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the install started");
    const lease = dispatcher.dispatch(
      "lease.request",
      {
        allowDownload: true,
        model: "iPhone 17 Pro",
        osVersion: "27.0",
        platform: "ios",
      },
      session(),
    );
    await until(() => installerCalls.mock.calls.length === 2, "the lease reached the installer");
    expect(installerCalls.mock.calls.map(([request]) => request.component)).toEqual([
      "27.0",
      "27.0",
    ]);
    driver.releaseInstalls();

    await expect(install).resolves.toMatchObject({ outcome: "installed", version: "27.0" });
    await expect(lease).resolves.toMatchObject({ device: { spec: { osVersion: "27.0" } } });
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("runs one install for two calls naming the same component, and gives both its outcome", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.holdInstalls();

    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");
    const second = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ principal: "tok_second" }),
    );
    driver.releaseInstalls();

    const expected = { component: "27.0", outcome: "installed", platform: "ios", version: "27.0" };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    expect(installCalls(driver)).toEqual([["27.0"]]);
  });

  it("refuses a version containing whitespace with BAD_REQUEST before any driver call", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27 .0" }, admin()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      dispatcher.dispatch("component.install", { platform: "ios", version: "27.0\n" }, admin()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(driver.calls).toEqual([]);
  });

  it("answers NO_DRIVER for a platform with no driver, and admits nothing", async () => {
    const { dispatcher } = await buildDispatcher();
    const onStarted = vi.fn();

    const error = await dispatcher
      .dispatch("component.install", { platform: "android", version: "35" }, admin({ onStarted }))
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("NO_DRIVER");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("tells the session the call was admitted before it settles", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.holdInstalls();
    const onStarted = vi.fn();

    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onStarted }),
    );
    await until(() => installCalls(driver).length === 1, "the install started");

    expect(onStarted).toHaveBeenCalledOnce();
    driver.releaseInstalls();
    await install;
  });

  it("answers RUNTIME_MISSING when the driver says the component cannot be installed", async () => {
    const { dispatcher, driver } = await buildDispatcher();
    driver.failOn(
      "installComponent",
      1,
      new RuntimeMissingError("ios", "12.0", { downloadable: false }),
    );

    const error = await dispatcher
      .dispatch("component.install", { platform: "ios", version: "12.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("RUNTIME_MISSING");
  });

  it("names the session's principal as the requester of the install it starts", async () => {
    const { dispatcher, eventBus } = await buildDispatcher();
    const started: unknown[] = [];
    eventBus.subscribeAll((envelope) => {
      if (envelope.event === "component.install-started") started.push(envelope.payload);
    });

    await dispatcher.dispatch("component.install", { platform: "ios", version: "27.0" }, admin());

    expect(started).toEqual([
      { componentId: "27.0", platform: "ios", requesterId: "tok_operator" },
    ]);
  });

  it("reports a driver's percentage as a fraction clamped to 0..1, and leaves out one that is not a number", async () => {
    const { dispatcher } = await buildDispatcher({
      driverOptions: { installProgress: [Number.NaN, -5, 50, 150] },
    });
    const progress: unknown[] = [];

    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );

    expect(progress).toEqual([
      { stage: "downloading" },
      { stage: "downloading" },
      { fraction: 0, stage: "downloading" },
      { fraction: 0.5, stage: "downloading" },
      { fraction: 1, stage: "downloading" },
    ]);
  });

  async function fractionsFor(percents: readonly number[]): Promise<unknown[]> {
    const { dispatcher } = await buildDispatcher({ driverOptions: { installProgress: percents } });
    const fractions: unknown[] = [];
    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({
        onComponentProgress: (update) => {
          if ("fraction" in update) fractions.push(update.fraction);
        },
      }),
    );
    return fractions;
  }

  it.each([
    // why: 1.1 / 100 is 0.011000000000000001 in floating point.
    { expected: [0.011, 1], percents: [1.1] },
    // why: 64.1 / 100 is 0.6409999999999999 in floating point.
    { expected: [0.641, 1], percents: [64.1] },
    { expected: [0.999, 1], percents: [99.96, 100] },
  ])(
    "sends the percentages $percents as the fractions $expected, rounded to three decimals",
    async ({ expected, percents }) => {
      await expect(fractionsFor(percents)).resolves.toEqual(expected);
    },
  );

  it("sends no fraction with more than three decimals for any percentage from 0 to 100 in steps of 0.1", async () => {
    const percents: number[] = [];
    for (let percent = 0, step = 0; step <= 1000; step += 1, percent += 0.1) percents.push(percent);

    const fractions = await fractionsFor(percents);

    expect(fractions.length).toBeGreaterThanOrEqual(1001);
    expect(fractions.filter((fraction) => !/^[01](\.\d{1,3})?$/.test(String(fraction)))).toEqual(
      [],
    );
  });

  it("tells a caller behind another install on the platform that it waits, then that it downloads", async () => {
    const { dispatcher, driver } = await buildDispatcher({
      driverOptions: { installProgress: [41] },
    });
    driver.holdInstalls();
    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");

    const progress: unknown[] = [];
    const second = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "28.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );
    await until(() => progress.length === 1, "the second call heard it waits");
    expect(progress).toEqual([{ stage: "waiting" }]);
    driver.releaseInstalls();

    await first;
    await expect(second).resolves.toMatchObject({ outcome: "installed", version: "28.0" });
    expect(progress).toEqual([
      { stage: "waiting" },
      { stage: "downloading" },
      { fraction: 0.41, stage: "downloading" },
      { fraction: 1, stage: "downloading" },
    ]);
  });

  it("tells a caller that joins an install already running its latest progress while the install is still running", async () => {
    const { dispatcher, driver } = await buildDispatcher({
      driverOptions: { installProgress: [41] },
    });
    driver.holdInstalls();
    const first = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await until(() => installCalls(driver).length === 1, "the first install started");

    const progress: unknown[] = [];
    const joined = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin({ onComponentProgress: (update) => progress.push(update) }),
    );
    await until(() => progress.length === 1, "the joining call heard the latest progress");
    expect(progress).toEqual([{ fraction: 0.41, stage: "downloading" }]);

    driver.releaseInstalls();
    await first;
    await expect(joined).resolves.toMatchObject({ outcome: "installed", version: "27.0" });
    expect(installCalls(driver)).toHaveLength(1);
  });
});

describe("Dispatcher: component.list", () => {
  it("lets an agent session list the installed components, the one Simlock installed marked as its", async () => {
    const { clock, dispatcher } = await buildDispatcher();
    await dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      session({ principal: "tok_operator", role: "admin" }),
    );

    const result = await dispatcher.dispatch("component.list", {}, session());

    expect(result).toEqual({
      components: [
        {
          devices: 0,
          foreignDevices: 0,
          installedBySimlock: false,
          platform: "ios",
          version: "26.5",
        },
        {
          devices: 0,
          foreignDevices: 0,
          installedAt: clock.now(),
          installedBySimlock: true,
          platform: "ios",
          version: "27.0",
        },
      ],
    });
  });

  it("lists only the platform asked for", async () => {
    const { dispatcher } = await buildDispatcher();

    await expect(
      dispatcher.dispatch("component.list", { platform: "android" }, session()),
    ).resolves.toEqual({ components: [] });
  });
});

describe("Dispatcher: component.remove", () => {
  const admin = (overrides: Partial<DispatchSession> = {}) =>
    session({ principal: "tok_operator", role: "admin", ...overrides });

  function driverCalls(driver: FakeDriver, operation: string): number {
    return driver.calls.filter((call) => call.operation === operation).length;
  }

  async function withSimlockInstall() {
    const built = await buildDispatcher({
      driverOptions: { componentSizes: { "27.0": 7_000_000_000 }, knownModels: ["iPhone 17 Pro"] },
    });
    await built.dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    return built;
  }

  it("removes a component Simlock installed and emits component.removed with the admin principal as requesterId", async () => {
    const { dispatcher, eventBus } = await withSimlockInstall();

    await expect(
      dispatcher.dispatch(
        "component.remove",
        { platform: "ios", version: "27.0" },
        admin({ principal: "tok_remover" }),
      ),
    ).resolves.toEqual({
      outcome: "removed",
      platform: "ios",
      sizeBytes: 7_000_000_000,
      version: "27.0",
    });
    expect(
      eventBus
        .replay()
        .filter((envelope) => envelope.event === "component.removed")
        .map((envelope) => envelope.payload),
    ).toEqual([
      {
        componentId: "27.0",
        platform: "ios",
        requesterId: "tok_remover",
        sizeBytes: 7_000_000_000,
        version: "27.0",
      },
    ]);
  });

  it("answers a dry run with would-remove and removes nothing", async () => {
    const { dispatcher, driver } = await withSimlockInstall();

    await expect(
      dispatcher.dispatch(
        "component.remove",
        { dryRun: true, platform: "ios", version: "27.0" },
        admin(),
      ),
    ).resolves.toEqual({
      outcome: "would-remove",
      platform: "ios",
      sizeBytes: 7_000_000_000,
      version: "27.0",
    });
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses an agent session with FORBIDDEN and never reaches the installer", async () => {
    const { components, dispatcher } = await withSimlockInstall();
    const removals = vi.spyOn(components, "remove");

    await expect(
      dispatcher.dispatch("component.remove", { platform: "ios", version: "27.0" }, session()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(removals).not.toHaveBeenCalled();
  });

  it("refuses a component Simlock did not install with COMPONENT_NOT_OWNED", async () => {
    const { dispatcher, driver } = await buildDispatcher();

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "26.5" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("COMPONENT_NOT_OWNED");
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses a component a leased device uses with COMPONENT_IN_USE, carrying both counts as details", async () => {
    const { dispatcher, driver, registry } = await withSimlockInstall();
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
      session(),
    );
    expect(registry.snapshot.devices.map((device) => device.state)).toEqual(["leased"]);

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DispatchError);
    expect(error).toMatchObject({
      code: "COMPONENT_IN_USE",
      details: { devices: 1, foreignDevices: 0 },
    });
    expect(classifyError(error)).toBe("COMPONENT_IN_USE");
    expect(driverCalls(driver, "removeComponent")).toBe(0);
  });

  it("refuses with COMPONENT_BUSY while an install runs on that platform", async () => {
    const { dispatcher, driver } = await withSimlockInstall();
    driver.holdInstalls();
    const install = dispatcher.dispatch(
      "component.install",
      { platform: "ios", version: "28.0" },
      admin(),
    );
    await vi.waitFor(() => expect(driverCalls(driver, "installComponent")).toBe(2));

    const error = await dispatcher
      .dispatch("component.remove", { platform: "ios", version: "27.0" }, admin())
      .catch((caught: unknown) => caught);

    expect(classifyError(error)).toBe("COMPONENT_BUSY");
    driver.releaseInstalls();
    await install;
  });

  it("rejects a lease request that resolves to the version being removed with RUNTIME_MISSING, and creates no device record", async () => {
    const { dispatcher, driver, registry } = await withSimlockInstall();
    driver.holdRemovals();
    const removal = dispatcher.dispatch(
      "component.remove",
      { platform: "ios", version: "27.0" },
      admin(),
    );
    await vi.waitFor(() => expect(driverCalls(driver, "removeComponent")).toBe(1));

    let leaseError: unknown;
    let leaseSettled = false;
    void dispatcher
      .dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "27.0", platform: "ios" },
        session(),
      )
      .then(
        () => undefined,
        (caught: unknown) => {
          leaseError = caught;
        },
      )
      .finally(() => {
        leaseSettled = true;
      });
    await vi.waitFor(() => expect(leaseSettled).toBe(true));

    expect(classifyError(leaseError)).toBe("RUNTIME_MISSING");
    expect(registry.snapshot.devices).toEqual([]);
    expect(driverCalls(driver, "provision")).toBe(0);
    driver.releaseRemovals();
    await expect(removal).resolves.toMatchObject({ outcome: "removed" });
  });
});
