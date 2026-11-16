import { describe, expect, it } from "vitest";
import {
  ComponentInstallerClosedError,
  type ComponentInstallerProgress,
} from "./component-installer.js";
import { ComponentInstallTimeoutError, DriverCrashError } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import {
  gibibyte,
  timeoutMs,
  ManualClock,
  createHarness,
  installs,
  flush,
  track,
  ios,
} from "./test-component-installer.js";

describe("ComponentInstaller", () => {
  it("fails a call still waiting when downloads.timeoutMs has passed since it arrived, without calling its driver", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0")).catch(() => undefined);
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    harness.clock.advance(timeoutMs);
    await flush();

    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    // Nothing is ahead of it any more, and its install still never reaches the driver.
    harness.ios.releaseInstalls();
    await flush();
    expect(harness.ios.calls.map((call) => call.arguments[0])).not.toContain("28.0");
  });

  it("aborts the install of a call that waited for half its budget when the other half has passed, not a full budget later", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    await flush();
    harness.clock.advance(1);
    const behind = track(harness.installer.install(ios("28.0")));
    await flush();
    // Half its budget spent waiting; then the install ahead ends and its own starts.
    harness.clock.advance(timeoutMs / 2);
    harness.ios.releaseInstalls();
    harness.ios.holdInstalls();
    await flush();
    expect(installs(harness.ios)).toEqual(["27.0", "28.0"]);

    harness.clock.advance(timeoutMs / 2 - 1);
    await flush();
    expect(behind.settled()).toBe(false);
    harness.clock.advance(1);
    await flush();
    expect(behind.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
      "component.install-started",
      "component.install-failed",
    ]);
  });

  it("aborts a running install at the deadline of the oldest call joined to it, and fails a call that joined later at that moment", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const oldest = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(10_000);
    const later = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs - 10_000);
    await flush();

    const timedOut = new ComponentInstallTimeoutError("ios", "27.0", timeoutMs);
    expect(oldest.error()).toEqual(timedOut);
    expect(later.error()).toEqual(timedOut);
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.install-failed",
    ]);
  });

  // Every call has the same budget, so a waiting call's deadline never falls before that of the
  // oldest call on the install running ahead of it. Firing only the waiting call's timer is what
  // shows its expiry touches nothing but its own call and its own install.
  it("leaves the install running ahead of a waiting call alone when that call times out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    const ahead = track(harness.installer.install(ios("27.0")));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    (harness.clock as ManualClock).fire(1);
    await flush();
    expect(waiting.error()).toEqual(new ComponentInstallTimeoutError("ios", "28.0", timeoutMs));
    harness.ios.releaseInstalls();
    await flush();

    expect(ahead.result()).toEqual({ outcome: "installed", version: "27.0" });
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
    ]);
  });

  it("starts no install for a waiting install whose only call timed out", async () => {
    const harness = await createHarness({ clock: new ManualClock() });
    harness.ios.holdInstalls();

    void harness.installer.install(ios("27.0"));
    void harness.installer.install(ios("28.0")).catch(() => undefined);
    await flush();
    (harness.clock as ManualClock).fire(1);
    await flush();
    harness.ios.releaseInstalls();
    await flush();

    expect(installs(harness.ios)).toEqual(["27.0"]);
  });

  it("gives the disk back when an install ends, so the next install that fits alone starts", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({
          availableOsVersions: [],
          clock,
          componentFootprint: { bytes: 6 * gibibyte, path: "/volume" },
          platform: "ios",
        }),
      ],
      freeDiskBytes: 10 * gibibyte,
    });
    harness.ios.failOn("installComponent", 1, new DriverCrashError("xcodebuild failed"));

    await expect(harness.installer.install(ios("27.0"))).rejects.toThrow("xcodebuild failed");
    await expect(harness.installer.install(ios("28.0"))).resolves.toMatchObject({
      outcome: "installed",
    });
    await expect(harness.installer.install(ios("29.0"))).resolves.toMatchObject({
      outcome: "installed",
    });
    expect(harness.reservations.map((reservation) => reservation.released)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("keeps the deadline of a call that ended as not-needed from ending the install the other calls joined", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const notNeeded = track(
      harness.installer.install(ios("27.0", { stillNeeded: async () => false })),
    );
    harness.clock.advance(1);
    const needed = track(harness.installer.install(ios("27.0")));
    await flush();
    expect(notNeeded.result()).toEqual({ outcome: "not-needed" });
    expect(installs(harness.ios)).toEqual(["27.0"]);

    // The not-needed call's budget runs out here; the install belongs to the other call now.
    harness.clock.advance(timeoutMs - 1);
    await flush();
    expect(needed.settled()).toBe(false);
    harness.clock.advance(1);
    await flush();
    expect(needed.error()).toEqual(new ComponentInstallTimeoutError("ios", "27.0", timeoutMs));
  });

  it("starts a new install for a call that arrives while a timed-out install's driver is still returning, after it returns", async () => {
    let finishStubborn: (() => void) | undefined;
    class StubbornDriver extends FakeDriver {
      readonly started: string[] = [];

      override async installComponent(
        component: string,
        options: Parameters<FakeDriver["installComponent"]>[1],
      ) {
        this.started.push(component);
        if (this.started.length === 1) {
          // Ignores its signal, like an installer that takes a while to die.
          await new Promise<void>((resolve) => {
            finishStubborn = resolve;
          });
          throw new DriverCrashError("ended late");
        }
        return super.installComponent(component, options);
      }
    }
    const harness = await createHarness({
      drivers: (clock) => [new StubbornDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });
    const driver = harness.ios as StubbornDriver;

    const first = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs);
    await flush();
    expect(first.error()).toBeInstanceOf(ComponentInstallTimeoutError);
    const second = track(harness.installer.install(ios("27.0")));
    await flush();
    expect(driver.started).toEqual(["27.0"]);

    finishStubborn?.();
    await flush();
    expect(driver.started).toEqual(["27.0", "27.0"]);
    expect(second.result()).toEqual({ outcome: "installed", version: "27.0" });
  });

  it("rejects only the call whose stillNeeded throws, and installs for the others joined to it", async () => {
    const harness = await createHarness();
    const failure = new Error("resolve failed");
    // An install ahead keeps all three waiting, so each reaches the front with its check.
    harness.ios.holdInstalls();
    void harness.installer.install(ios("28.0"));
    await flush();
    harness.ios.releaseInstalls();

    const [plain, throwing, notNeeded] = await Promise.allSettled([
      harness.installer.install(ios("27.0")),
      harness.installer.install(
        ios("27.0", {
          stillNeeded: async () => {
            throw failure;
          },
        }),
      ),
      harness.installer.install(ios("27.0", { stillNeeded: async () => false })),
    ]);

    expect(plain).toEqual({
      status: "fulfilled",
      value: { outcome: "installed", version: "27.0" },
    });
    expect(throwing).toEqual({ reason: failure, status: "rejected" });
    expect(notNeeded).toEqual({ status: "fulfilled", value: { outcome: "not-needed" } });
    expect(installs(harness.ios)).toEqual(["28.0", "27.0"]);
  });

  it("keeps a throwing progress callback from reaching the install or the other calls", async () => {
    const harness = await createHarness({
      drivers: (clock) => [
        new FakeDriver({ availableOsVersions: [], clock, installProgress: [50], platform: "ios" }),
      ],
    });
    const heard: ComponentInstallerProgress[] = [];

    const [throwing, listening] = await Promise.allSettled([
      harness.installer.install(
        ios("27.0", {
          onProgress: () => {
            throw new Error("observer broke");
          },
        }),
      ),
      harness.installer.install(ios("27.0", { onProgress: (report) => heard.push(report) })),
    ]);

    expect(throwing).toMatchObject({ status: "fulfilled" });
    expect(listening).toMatchObject({ status: "fulfilled" });
    expect(heard).toEqual([
      { stage: "downloading" },
      { percent: 50, stage: "downloading" },
      { percent: 100, stage: "downloading" },
    ]);
  });

  it.each([
    ["checking whether the component is installed", "findComponent"],
    ["reserving disk", "diskFree"],
  ] as const)(
    "starts no install when the only call ran out of budget while the installer was %s",
    async (_step, slow) => {
      const harness = await createHarness({
        drivers: (clock) => [
          new FakeDriver({
            availableOsVersions: [],
            clock,
            latencyMs: slow === "findComponent" ? { findComponent: timeoutMs + 1 } : {},
            platform: "ios",
          }),
        ],
        filesystem: (clock) => ({
          diskFree: async () => {
            if (slow === "diskFree") {
              await new Promise<void>((resolve) => clock.setTimer(timeoutMs + 1, resolve));
            }
            return Number.MAX_SAFE_INTEGER;
          },
        }),
      });

      const call = track(harness.installer.install(ios("27.0")));
      await flush();
      harness.clock.advance(timeoutMs);
      await flush();
      expect(call.error()).toBeInstanceOf(ComponentInstallTimeoutError);
      harness.clock.advance(1);
      await flush();

      expect(installs(harness.ios)).toEqual([]);
      expect(harness.events).toEqual([]);
      // Nothing reserved once the call is gone; a reservation already taken is given back.
      expect(harness.reservations).toEqual(
        slow === "findComponent" ? [] : [{ bytes: 0, released: true }],
      );
    },
  );

  it("resolves close only once the running driver call has returned", async () => {
    let finishStubborn: (() => void) | undefined;
    class StubbornDriver extends FakeDriver {
      override async installComponent(): ReturnType<FakeDriver["installComponent"]> {
        // Ignores its signal, like an installer that takes a while to die.
        await new Promise<void>((resolve) => {
          finishStubborn = resolve;
        });
        throw new DriverCrashError("ended late");
      }
    }
    const harness = await createHarness({
      drivers: (clock) => [new StubbornDriver({ availableOsVersions: [], clock, platform: "ios" })],
    });

    void harness.installer.install(ios("27.0")).catch(() => undefined);
    await flush();
    const closing = track(harness.installer.close());
    await flush();
    expect(closing.settled()).toBe(false);

    finishStubborn?.();
    await flush();
    expect(closing.settled()).toBe(true);
  });

  it("fails only the call whose budget runs out while a finished install's record is written, and installs for the rest", async () => {
    // A gate the test opens by hand, standing in for other registry writes ahead of the record.
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const harness = await createHarness({
      decisions: {
        run: async <Result>(operation: () => Result | Promise<Result>) => {
          await gate;
          return operation();
        },
      },
    });

    const oldest = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(1);
    const later = track(harness.installer.install(ios("27.0")));
    await flush();
    harness.clock.advance(timeoutMs - 1);
    await flush();
    expect(oldest.error()).toEqual(new ComponentInstallTimeoutError("ios", "27.0", timeoutMs));
    expect(later.settled()).toBe(false);

    openGate?.();
    await flush();
    expect(later.result()).toEqual({ outcome: "installed", version: "27.0" });
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.installed",
    ]);
  });

  it("aborts the running install and rejects the waiting calls on close", async () => {
    const harness = await createHarness();
    harness.ios.holdInstalls();

    const running = track(harness.installer.install(ios("27.0")));
    const waiting = track(harness.installer.install(ios("28.0")));
    await flush();
    await harness.installer.close();
    await flush();

    expect(running.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(waiting.error()).toBeInstanceOf(ComponentInstallerClosedError);
    expect(installs(harness.ios)).toEqual(["27.0"]);
    expect(harness.events.map((event) => event.event)).toEqual([
      "component.install-started",
      "component.install-failed",
    ]);
    await expect(harness.installer.install(ios("29.0"))).rejects.toBeInstanceOf(
      ComponentInstallerClosedError,
    );
  });
});
