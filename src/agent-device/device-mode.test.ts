import { describe, expect, it } from "vitest";

import {
  adminSession,
  allocate,
  forwarded,
  granted,
  hex,
  iosDriver,
  leases,
  receivedAllocate,
  refused,
  requestedSpecs,
  runCommand,
  setUp,
  simlockMessage,
  type Rig,
} from "./test-support.js";

async function grantedMode(rig: Rig, n: number): Promise<unknown> {
  const lease = (await leases(rig)).find((entry) => entry.id === hex(n));
  const devices = (await rig.daemon.dispatch(
    "list.get",
    { kind: "devices" },
    adminSession,
  )) as unknown as readonly { readonly id: string; readonly mode?: string }[];
  return devices.find((device) => device.id === lease?.deviceId)?.mode;
}

describe("the agent-device front's `deviceMode`", () => {
  it('allocate with `deviceMode` "full" or "slim" makes a lease request whose `mode` is it, grants a device of that mode, and sends an allocate the agent-device daemon receives without it; `deviceMode: null` is absent; any other `deviceMode` answers `refused by simlock:` with the message `lease.request` gives it and no lease', async () => {
    const rig = await setUp({
      drivers: (clock) => [iosDriver(clock, ["26.5"])],
      maxRunning: 8,
    });

    await granted(rig, 1, { deviceMode: "full" });
    await granted(rig, 2, { deviceMode: "slim" });
    await granted(rig, 3, { deviceMode: null });
    for (const deviceMode of ["fast", 1]) {
      const expected = await simlockMessage(rig, {
        leaseId: hex(9),
        mode: deviceMode,
        platform: "ios",
      });
      await refused(rig, () => allocate(rig, 4, { deviceMode }), `refused by simlock: ${expected}`);
    }

    expect(await requestedSpecs(rig, hex(1))).toEqual([{ mode: "full", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(2))).toEqual([{ mode: "slim", platform: "ios" }]);
    expect(await requestedSpecs(rig, hex(3))).toEqual([{ platform: "ios" }]);
    expect(await grantedMode(rig, 1)).toBe("full");
    expect(await grantedMode(rig, 2)).toBe("slim");
    expect(receivedAllocate(rig, 1)).not.toHaveProperty("deviceMode");
    expect(receivedAllocate(rig, 2)).not.toHaveProperty("deviceMode");
    expect((await leases(rig)).map((lease) => lease.id)).toEqual([hex(1), hex(2), hex(3)]);
  });

  it("a command with `deviceMode` on `flags`, on `input` or inside a batch step reaches agent-device without it", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const sent = { deviceMode: "full", platform: "ios" };

    const onFlags = await forwarded(rig, () => runCommand(rig, "snapshot", 1, { flags: sent }));
    const onInput = await forwarded(rig, () => runCommand(rig, "snapshot", 1, { input: sent }));
    const inStep = await forwarded(rig, () =>
      runCommand(rig, "batch", 1, {
        flags: { batchSteps: [{ command: "snapshot", flags: sent }] },
      }),
    );

    expect(onFlags["flags"]).toEqual({ platform: "ios" });
    expect(onInput["input"]).toEqual({ platform: "ios" });
    const steps = (inStep["flags"] as { batchSteps: { flags: unknown }[] }).batchSteps;
    expect(steps[0]?.flags).toEqual({ platform: "ios" });
  });
});
