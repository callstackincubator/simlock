import { describe, expect, it } from "vitest";

import { SCREEN_FRAME_TAG, ScreenUnavailableError } from "../../../core/index.js";

import { START_DEADLINE_MS } from "./session.js";
import {
  SERVER,
  DEVICE_JAR,
  SETTINGS,
  SCREEN_READ_MS,
  WAKE_MS,
  PHONE,
  GATE_REFUSAL,
  SCREEN_OFF,
  FakeTarget,
  setup,
  drive,
  streamStart,
  frameTag,
  waitThenStart,
} from "./test-session.js";

describe("Android screen capture: a phone's screen state", () => {
  it("wakes a phone whose screen is off through its target with a 10 s limit, reads again, and pushes once the second read says it is on, for each wakefulness that means off", async () => {
    for (const printed of ["Asleep", "Dozing", "Asleep\r", "Dozing "]) {
      const world = await setup({
        device: PHONE,
        power: [
          { code: 0, stdout: `  mWakefulness=${printed}\n` },
          { code: 0, stdout: "  mWakefulness=Awake\n" },
        ],
      });
      const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
      const feed = await drive(world.clock, waitThenStart(world.target, opening));
      expect(frameTag((await feed.body.getReader().read()).value), printed).toBe(
        SCREEN_FRAME_TAG.meta,
      );

      expect(world.target.screenSteps, printed).toEqual(["read", "wake", "read"]);
      expect(world.target.wakes, printed).toEqual([WAKE_MS]);
      expect(world.target.powerReads, printed).toEqual([SCREEN_READ_MS, SCREEN_READ_MS]);
      expect(world.target.log[0], printed).toBe(`push ${SERVER} ${DEVICE_JAR}`);
    }
  });

  it("refuses a phone whose second read still says the screen is off, with its own reason, and pushes nothing, whatever the wake did", async () => {
    for (const second of ["Asleep", "Dozing"]) {
      for (const wake of ["ok", "fail", "slow"] as const) {
        const world = await setup({
          device: PHONE,
          wake,
          power: [
            { code: 0, stdout: "  mWakefulness=Asleep\n" },
            { code: 0, stdout: `  mWakefulness=${second}\n` },
          ],
        });
        const error = await drive(
          world.clock,
          world.capture.open(PHONE, SETTINGS, new AbortController().signal),
        ).catch((caught: unknown) => caught);

        const name = `${second} after a wake that is ${wake}`;
        expect(error, name).toBeInstanceOf(ScreenUnavailableError);
        expect((error as Error).message, name).toBe(SCREEN_OFF);
        // why: a wake that exited non-zero or timed out is not looked at; the second read decides.
        expect(world.target.screenSteps, name).toEqual(["read", "wake", "read"]);
        expect(world.target.steps, name).toEqual([]);
        expect(world.target.connects, name).toEqual([]);
      }
    }
  });

  it.each([
    { name: "Awake", power: { code: 0, stdout: "  mWakefulness=Awake\n" } },
    { name: "Dreaming", power: { code: 0, stdout: "  mWakefulness=Dreaming\n" } },
    { name: "Awaken", power: { code: 0, stdout: "  mWakefulness=Awaken\n" } },
    { name: "asleep", power: { code: 0, stdout: "  mWakefulness=asleep\n" } },
    { name: "no matching line", power: { code: 0, stdout: "  mPolicyBoost=0\n" } },
    { name: "a non-zero exit", power: { code: 1, stdout: "  mWakefulness=Asleep\n" } },
    { name: "a slow read", power: "slow" },
  ] as const)(
    "goes on to the push, without a wake, after one 10 s screen read that says $name",
    async ({ name, power }) => {
      const world = await setup({ device: PHONE, power });
      const opening = world.capture.open(PHONE, SETTINGS, new AbortController().signal);
      // why: a timed-out read ends 10 s of fake clock after the open, and waitThenStart's capped
      // flush-wait cannot span it; the file's uncapped watcher pattern waits for the peer whenever
      // it appears, and drive still ends the run if the open never reaches it.
      const watcher = (async () => {
        while (world.target.server.peers.length === 0)
          await new Promise((resolve) => setImmediate(resolve));
        world.target.server.last.send(streamStart());
      })();
      const feed = await drive(world.clock, opening);
      await watcher;
      expect(frameTag((await feed.body.getReader().read()).value), name).toBe(
        SCREEN_FRAME_TAG.meta,
      );

      expect(world.target.powerReads, name).toEqual([SCREEN_READ_MS]);
      expect(world.target.wakes, name).toEqual([]);
      expect(world.target.log[0], name).toBe(`push ${SERVER} ${DEVICE_JAR}`);
    },
  );

  it("checks for a stop after each of the first read, the wake and the second read, and does nothing after the step it was stopped in", async () => {
    const asleep = { code: 0, stdout: "  mWakefulness=Asleep\n" };
    const awake = { code: 0, stdout: "  mWakefulness=Awake\n" };
    const cases = [
      { name: "the first read", power: [asleep], wake: "ok", wakes: 0, reads: 1, hold: true },
      { name: "the wake", power: [asleep, awake], wake: "slow", wakes: 1, reads: 1, hold: false },
      {
        name: "the second read",
        power: [asleep, "slow"],
        wake: "ok",
        wakes: 1,
        reads: 2,
        hold: false,
      },
    ] as const;
    for (const stage of cases) {
      const stop = new AbortController();
      const world = await setup({
        device: PHONE,
        power: stage.power as unknown as FakeTarget["power"],
        wake: stage.wake,
      });
      world.target.holdReads = stage.hold;
      const opening = world.capture.open(PHONE, SETTINGS, stop.signal);
      // why: stops at the step itself: the step is in flight once its entry is recorded.
      while (
        stage.name === "the first read"
          ? world.target.powerReads.length < 1
          : stage.name === "the wake"
            ? world.target.wakes.length < 1
            : world.target.powerReads.length < 2
      )
        await new Promise((resolve) => setImmediate(resolve));
      stop.abort();
      const failed = await drive(world.clock, opening).catch((caught: unknown) => caught);

      expect(failed, stage.name).toBeInstanceOf(ScreenUnavailableError);
      expect(world.target.wakes.length, stage.name).toBe(stage.wakes);
      expect(world.target.powerReads.length, stage.name).toBe(stage.reads);
      expect(world.target.log, stage.name).toEqual([]);
      expect(world.target.connects, stage.name).toEqual([]);
    }
  });

  it("fails the open with a target's own reason and runs nothing after it, for the first screen read, the wake, the second screen read, the push, the server start and a connection attempt", async () => {
    const stages: readonly {
      readonly name: string;
      readonly power?: FakeTarget["power"];
      readonly wake?: FakeTarget["wake"];
      readonly refuses: (args: readonly string[]) => boolean;
      readonly screenBefore: string[];
      readonly stepsBefore: string[];
    }[] = [
      {
        name: "the first screen read",
        power: "refuse",
        refuses: () => false,
        screenBefore: ["read"],
        stepsBefore: [],
      },
      {
        // why: the wake's exit is ignored, but a closed check at the wake still refuses the open.
        name: "the wake",
        power: { code: 0, stdout: "  mWakefulness=Asleep\n" },
        wake: "refuse",
        refuses: () => false,
        screenBefore: ["read", "wake"],
        stepsBefore: [],
      },
      {
        name: "the second screen read",
        power: [{ code: 0, stdout: "  mWakefulness=Asleep\n" }, "refuse"],
        refuses: () => false,
        screenBefore: ["read", "wake", "read"],
        stepsBefore: [],
      },
      {
        name: "the push",
        refuses: (args) => args[0] === "push",
        screenBefore: ["read"],
        stepsBefore: [],
      },
      {
        name: "the server start",
        refuses: (args) => args.includes("app_process"),
        screenBefore: ["read"],
        stepsBefore: [`push ${SERVER} ${DEVICE_JAR}`, `shell rm -f ${DEVICE_JAR}`],
      },
      {
        // why: the server's spawn sits between the push and the connection attempt, so it is in the
        // log by the time the attempt's check refuses; only the `rm -f` follows it.
        name: "a connection attempt",
        refuses: (args) => args[0] === "connect",
        screenBefore: ["read"],
        stepsBefore: [`push ${SERVER} ${DEVICE_JAR}`, "server", `shell rm -f ${DEVICE_JAR}`],
      },
    ];
    for (const stage of stages) {
      const world = await setup({
        device: PHONE,
        ...(stage.power === undefined ? {} : { power: stage.power }),
        ...(stage.wake === undefined ? {} : { wake: stage.wake }),
        refuses: stage.refuses,
      });
      const started = world.clock.now();
      const error = await drive(
        world.clock,
        world.capture.open(PHONE, SETTINGS, new AbortController().signal),
      ).catch((caught: unknown) => caught);

      expect(error, stage.name).toBeInstanceOf(ScreenUnavailableError);
      expect((error as Error).message, stage.name).toBe(GATE_REFUSAL);
      // why: a refusal that was retried instead of propagated would have spent the start deadline on
      // it, and the viewer would get a start timeout instead of the check's reason.
      expect(world.clock.now() - started, stage.name).toBeLessThan(START_DEADLINE_MS);
      expect(world.target.steps, stage.name).toEqual(stage.stepsBefore);
      expect(world.target.screenSteps, stage.name).toEqual(stage.screenBefore);
    }
  });

  it("sends nothing and settles when the version check is still closed at the jar's removal", async () => {
    const world = await setup({
      device: PHONE,
      refuses: (args) => args.includes("app_process") || args[0] === "shell",
    });
    const error = await drive(
      world.clock,
      world.capture.open(PHONE, SETTINGS, new AbortController().signal),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScreenUnavailableError);
    expect(world.target.steps).toEqual([`push ${SERVER} ${DEVICE_JAR}`]);
  });
});
