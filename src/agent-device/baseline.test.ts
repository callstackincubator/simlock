import { describe, expect, it } from "vitest";

import {
  adminSession,
  allocate,
  allocatesReceived,
  androidDriver,
  envelopeOf,
  forwarded,
  granted,
  hex,
  iosDriver,
  leases,
  principals,
  receivedAllocate,
  refusal,
  refused,
  requestedSpecs,
  runCommand,
  sessionFor,
  setUp,
  simlockMessage,
  type Rig,
} from "./test-support.js";

// why: a baseline is saved from a leased device, so every test here starts by leasing one and saving it.
async function saveBaseline(
  rig: Rig,
  name: string,
  spec: { readonly model: string; readonly platform: "ios" | "android" },
): Promise<void> {
  const grant = await rig.daemon.dispatch("lease.request", spec, sessionFor(principals.one));
  await rig.daemon.dispatch("baseline.save", { leaseId: grant.lease.id, name }, adminSession);
}

describe("the agent-device front's `deviceBaseline`", () => {
  it('allocate with `deviceBaseline` "logged-in" makes a lease request with `baseline: "logged-in"`, alone on iOS and (a baseline of its own) on Android, with `target: "mobile"` (no class) and with `device` (the model too)', async () => {
    const rig = await setUp({
      drivers: (clock) => [iosDriver(clock), androidDriver(clock)],
      maxRunning: 8,
    });
    await saveBaseline(rig, "logged-in", { model: "iPhone 17 Pro", platform: "ios" });
    await saveBaseline(rig, "logged-in-android", { model: "Pixel 8", platform: "android" });
    const cases = [
      [1, { platform: "ios" }, { baseline: "logged-in", platform: "ios" }],
      [
        2,
        { deviceBaseline: "logged-in-android", platform: "android" },
        { baseline: "logged-in-android", platform: "android" },
      ],
      [3, { platform: "ios", target: "mobile" }, { baseline: "logged-in", platform: "ios" }],
      [
        4,
        { device: "iPhone 17 Pro", platform: "ios" },
        { baseline: "logged-in", model: "iPhone 17 Pro", platform: "ios" },
      ],
    ] as const;

    for (const [n, extra, spec] of cases) {
      await granted(rig, n, { deviceBaseline: "logged-in", ...extra });
      expect(await requestedSpecs(rig, hex(n))).toEqual([spec]);
    }
  });

  it("the allocate the agent-device daemon receives carries no `deviceBaseline`", async () => {
    const rig = await setUp({ drivers: (clock) => [androidDriver(clock)], maxRunning: 8 });
    await saveBaseline(rig, "logged-in", { model: "Pixel 8", platform: "android" });

    await granted(rig, 1, { deviceBaseline: "logged-in", platform: "android" });

    expect(receivedAllocate(rig, 1)).not.toHaveProperty("deviceBaseline");
  });

  it("the relayed allocate reply carries `data.lease.device.baseline` as `{ name, version }` for a grant from a baseline, with the daemon's `deviceKey` and `data.device` unchanged", async () => {
    const rig = await setUp();
    await saveBaseline(rig, "logged-in", { model: "iPhone 16", platform: "ios" });
    await saveBaseline(rig, "logged-in", { model: "iPhone 16", platform: "ios" });
    rig.fake.nameDeviceKeyInNextReply("key-1");
    rig.fake.nameDeviceInNextReply({});

    const result = (await envelopeOf(await allocate(rig, 1, { deviceBaseline: "logged-in" })))
      .result as { data: { device: unknown; lease: Record<string, unknown> } };

    expect(result.data.lease["device"]).toEqual({
      baseline: { name: "logged-in", version: 2 },
      deviceMode: "full",
      model: "iPhone 16",
      osVersion: "26.5",
      physical: false,
      udid: expect.any(String),
    });
    expect(result.data.lease["deviceKey"]).toBe("key-1");
    expect(result.data.device).toMatchObject({ id: expect.any(String) });
  });

  it("allocate with a `deviceBaseline` Simlock refuses (unknown, model or platform mismatch, stale, an invalid name, beside `physical`) answers `refused by simlock:` with simlock's own message and leaves no lease", async () => {
    const rig = await setUp({ drivers: (clock) => [iosDriver(clock), androidDriver(clock)] });
    await saveBaseline(rig, "logged-in", { model: "iPhone 16", platform: "ios" });
    await saveBaseline(rig, "went-stale", { model: "iPhone 16", platform: "ios" });
    const sources = await rig.driver.listSources();
    const [, staleSource] = sources;
    rig.driver.setSources(
      sources.map((source) =>
        source === staleSource ? { ...source, staleReason: "runtime is not installed" } : source,
      ),
    );
    await rig.daemon.dispatch("baseline.list", {}, adminSession);
    const refusals: readonly (readonly [Record<string, unknown>, Record<string, unknown>])[] = [
      [{ deviceBaseline: "no-such" }, { baseline: "no-such" }],
      [
        { device: "iPhone 17 Pro", deviceBaseline: "logged-in" },
        { baseline: "logged-in", model: "iPhone 17 Pro" },
      ],
      [
        { deviceBaseline: "logged-in", platform: "android" },
        { baseline: "logged-in", platform: "android" },
      ],
      [{ deviceBaseline: "went-stale" }, { baseline: "went-stale" }],
      [{ deviceBaseline: "Logged In" }, { baseline: "Logged In" }],
      [
        { deviceBaseline: "logged-in", physical: true },
        { baseline: "logged-in", physical: true },
      ],
    ];
    const before = (await leases(rig)).length;

    for (const [index, [extra, spec]] of refusals.entries()) {
      const expected = await simlockMessage(rig, {
        leaseId: hex(190 + index),
        platform: "ios",
        ...spec,
      });
      const answer = await envelopeOf(await allocate(rig, 100 + index, extra));
      expect(answer.error?.message).toBe(`refused by simlock: ${expected}`);
    }
    expect((await leases(rig)).length).toBe(before);
    expect(allocatesReceived(rig)).toEqual([]);
  });

  it('allocate with `target: "watch"` beside a `deviceBaseline` answers `refused: unknown --target watch; use mobile, tv or desktop` and leaves no lease', async () => {
    const rig = await setUp();

    const answer = await envelopeOf(
      await allocate(rig, 1, { deviceBaseline: "logged-in", target: "watch" }),
    );

    expect(answer.error).toMatchObject(
      refusal("refused: unknown --target watch; use mobile, tv or desktop"),
    );
    expect(await leases(rig)).toEqual([]);
    expect(allocatesReceived(rig)).toEqual([]);
  });

  it("a command with `deviceBaseline` on `flags`, on `input` or inside a batch step reaches agent-device without it", async () => {
    const rig = await setUp();
    await granted(rig, 1);
    const sent = { deviceBaseline: "logged-in", platform: "ios" };

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

  it("allocate with a `deviceBaseline` that is a number is refused with `refused: malformed deviceBaseline`", async () => {
    const rig = await setUp();

    await refused(
      rig,
      () => allocate(rig, 1, { deviceBaseline: 7 }),
      "refused: malformed deviceBaseline",
    );
  });
});
