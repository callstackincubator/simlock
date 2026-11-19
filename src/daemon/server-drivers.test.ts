import { afterEach, describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { type DriverRejection, RuntimeMissingError } from "../core/index.js";
import { FakeClock } from "../ports/index.js";
import {
  createClient,
  createHarness,
  hello,
  rejectionNaming,
  stopTestDaemons,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("DaemonServer driver rejections", () => {
  it("publishes one event per platform that refused to start, after the daemon is up", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
          platform: "ios",
          reason: "wrong-instance",
          summary: "Refusing the ios device root /Devices: it belongs to another instance",
        },
        {
          event: "driver.adb-server-rejected",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });

    const events = harness.eventBus.replay();
    const rejected = events.filter(
      (event) =>
        event.event === "driver.root-rejected" || event.event === "driver.adb-server-rejected",
    );
    expect(rejected).toEqual([
      expect.objectContaining({
        event: "driver.root-rejected",
        module: "daemon",
        payload: { platform: "ios", reason: "wrong-instance", root: "/Devices" },
      }),
      expect.objectContaining({
        event: "driver.adb-server-rejected",
        module: "daemon",
        payload: { port: 5038, reason: "occupied" },
      }),
    ]);
    const started = events.find((event) => event.event === "daemon.started");
    for (const event of rejected) expect(started?.seq).toBeLessThan(event.seq);
  });

  it("names the refusal when a lease asks for a platform whose driver did not start", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.adb-server-rejected",
          payload: { port: 5038, reason: "occupied" },
          platform: "android",
          reason: "occupied",
          summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toContain("port 5038 is held by an adb server we do not own");
  });

  it("leaves an ordinary missing platform unexplained, having nothing to explain", async () => {
    const harness = await createHarness({
      driverRejections: [
        {
          event: "driver.root-rejected",
          payload: { platform: "ios", reason: "symlink", root: "/Devices" },
          platform: "ios",
          reason: "symlink",
          summary: "Refusing the ios device root /Devices: it is a symlink",
        },
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "Pixel 8",
      platform: "android",
    });

    expect(response.error?.code).toBe("NO_DRIVER");
    expect(response.error?.message).toBe("No driver registered for platform: android");
  });

  it.each([
    {
      name: "adb",
      rejection: {
        event: "driver.adb-server-rejected",
        payload: { port: 5038, reason: "occupied" },
        platform: "android",
        reason: "occupied",
        summary: "Refusing the Android driver: port 5038 is held by an adb server we do not own",
      },
      tools: ["adb"],
      request: { args: ["devices"], tool: "adb" },
      text: "port 5038 is held by an adb server we do not own",
    },
    {
      name: "devicectl",
      rejection: {
        event: "driver.root-rejected",
        payload: { platform: "ios", reason: "symlink", root: "/Devices" },
        platform: "ios",
        reason: "symlink",
        summary: "Refusing the ios device root /Devices: it is a symlink",
      },
      tools: ["simctl", "devicectl"],
      request: { args: ["list", "devices"], tool: "devicectl" },
      text: "Refusing the ios device root /Devices: it is a symlink",
    },
  ] as const)(
    "names the refusal when a $name passthrough asks for the tool whose driver did not start",
    async ({ rejection, request, text, tools }) => {
      const harness = await createHarness({
        driverRejections: [rejectionNaming(rejection, tools)],
      });
      const client = await createClient(harness.socketPath);
      await hello(client);

      const response = await client.request("driver.passthrough", {
        args: [...request.args],
        tool: request.tool,
      });

      expect(response.error?.code).toBe("UNKNOWN_PASSTHROUGH_TOOL");
      expect(response.error?.message).toContain(text);
    },
  );

  it("leaves an unknown passthrough tool unexplained when no driver claimed it", async () => {
    const harness = await createHarness({
      driverRejections: [
        rejectionNaming(
          {
            event: "driver.root-rejected",
            payload: { platform: "ios", reason: "symlink", root: "/Devices" },
            platform: "ios",
            reason: "symlink",
            summary: "Refusing the ios device root /Devices: it is a symlink",
          },
          ["simctl", "devicectl"],
        ),
      ],
    });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("driver.passthrough", {
      args: ["devices"],
      tool: "adb",
    });

    expect(response.error?.message).toBe("No driver provides a adb passthrough");
  });

  it("refuses at compile time to pair an event with another event's payload", () => {
    const rejection: DriverRejection = {
      event: "driver.adb-server-rejected",
      // @ts-expect-error -- `port` is a number on the wire (docs/internal/EVENTS.md).
      payload: { port: "5038", reason: "occupied" },
      platform: "android",
      reason: "occupied",
      summary: "Refusing the Android driver: port 5038 is occupied",
    };

    expect(rejection.event).toBe("driver.adb-server-rejected");
  });

  it("publishes nothing when every driver started", async () => {
    const harness = await createHarness();

    expect(harness.eventBus.replay().filter((event) => event.event.startsWith("driver."))).toEqual(
      [],
    );
  });
});

describe("DaemonServer download policy", () => {
  it("grants download permission under the always policy without a per-request flag", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, downloads: { policy: "always" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok).toBe(true);
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["26.5"]]);
    await client.close();
  });

  it("still answers a lease request whose download names a component past the progress push's bound, sending no downloading push for it", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    // why: the driver, not the request, names the component: a request's exact osVersion is held
    // within the push's bound. Every resolve before the install answers as a missing runtime does.
    for (const callNumber of [1, 2]) {
      driver.failOn(
        "resolveSpec",
        callNumber,
        new RuntimeMissingError("ios", "26.5", { component: "9".repeat(65) }),
      );
    }
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const grant = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(grant.ok, JSON.stringify(grant.error)).toBe(true);
    const stages = client
      .frames()
      .filter((frame) => frame.push === "progress")
      .map((frame) => (frame.payload as { progress: { stage: string } }).progress.stage);
    expect(stages).toContain("provisioning");
    expect(stages).not.toContain("downloading");
    await client.close();
  });

  it.each([
    ["asks for it", { allowDownload: true }],
    ["never asked for a download", {}],
  ])(
    "attaches the download-policy suffix and withholds download permission under the never policy even when the request %s",
    async (_name, extra) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
      const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
      const client = await createClient(harness.socketPath);
      await hello(client);

      // why: when the request never asked, the driver's own message still suggests `--allow-download`,
      // which under the never policy can never help, so the suffix must still attach as the
      // correction.
      const response = await client.request("lease.request", {
        ...extra,
        requesterId: "agent-1",
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });

      expect(response.ok).toBe(false);
      expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
      expect(response.error?.message).toContain("downloads.policy");
      expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");
      await client.close();
    },
  );

  it("defers to the request's own flag under the default on-request policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    const harness = await createHarness({ clock, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    expect(driver.calls.map((call) => call.operation)).not.toContain("installComponent");

    const flagged = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "26.5",
      platform: "ios",
    });

    expect(flagged.ok).toBe(true);
    expect(
      driver.calls
        .filter((call) => call.operation === "installComponent")
        .map((call) => call.arguments),
    ).toEqual([["26.5"]]);
    await client.close();
  });

  it("never attaches the download-policy suffix to an undownloadable RuntimeMissingError, even under the never policy", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.failOn(
      "resolveSpec",
      1,
      new RuntimeMissingError("ios", "12.0", { downloadable: false }),
    );
    const harness = await createHarness({ clock, downloads: { policy: "never" }, driver });
    const client = await createClient(harness.socketPath);
    await hello(client);

    const response = await client.request("lease.request", {
      allowDownload: true,
      requesterId: "agent-1",
      model: "iPhone 16",
      osVersion: "12.0",
      platform: "ios",
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "RUNTIME_MISSING" });
    expect(response.error?.message).not.toContain("downloads.policy");
    await client.close();
  });
});
