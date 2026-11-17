import { describe, expect, it } from "vitest";

import { readEnrolledApps } from "./helpers/state-db.js";
import {
  IPHONE,
  PIXEL,
  Row,
  UDID,
  add,
  leaseGrant,
  rows,
  startDaemon,
} from "./test-physical-enrollment.js";

describe("an enrolled physical device", () => {
  it("is not granted to a lease --platform ios: the lease gets a simulator", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);

    const grant = await env.cli(["lease", "--platform", "ios", "--agent-id", "sim", "--detach"]);

    expect(grant.code, grant.stderr).toBe(0);
    const device = (grant.json as { device: { id: string; physical: boolean } }).device;
    expect(device.physical).toBe(false);
    expect(device.id).not.toBe(enrolled.id);
  });

  it("shows its canonical ID as driverDeviceId in status --json from an operator and from an agent session and in list --devices, and a simulator's status entry has none", async () => {
    const env = await startDaemon({ ios: { physicalDevices: [IPHONE] } });
    await add(env, "ios", UDID);
    const simulator = await leaseGrant(env, "ios", "sim-agent");

    const operator = await env.cli(["status", "--json"]);
    const agent = await env.cli(["--token", "not-an-admin-credential", "status", "--json"]);

    for (const status of [operator, agent]) {
      expect(status.code, status.stderr).toBe(0);
      const devices = (status.json as { devices: Row[] }).devices;
      const physical = devices.find((device) => device.physical);
      const virtual = devices.find((device) => !device.physical);
      expect(physical?.driverDeviceId).toBe(UDID);
      expect(virtual).toBeDefined();
      expect(virtual?.driverDeviceId).toBeUndefined();
    }
    const listed = (await rows(env)).find((row) => row.physical);
    expect(listed?.driverDeviceId).toBe(UDID);
    expect(simulator.device.driverDeviceId).not.toBe(UDID);
  });
});

describe("android enrolment", () => {
  it("records the apps the driver lists and shows the device with its Android OS version", async () => {
    const env = await startDaemon({ android: { physicalDevices: [PIXEL] } });

    const result = await env.cli(["device", "add", "--platform", "android", "R58M123ABC"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Enrolled Pixel 9 (Android 15) as R58M123ABC, 1 user app recorded.\n",
    );
    expect(readEnrolledApps(env)).toEqual([["com.example.mail"]]);
  });
});
