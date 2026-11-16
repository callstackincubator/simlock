import { describe, it, expect } from "vitest";
import {
  type ProcessRunner,
  ScriptedProcessRunner,
  FakeClock,
  type ProcessRunOptions,
  type ProcessResult,
  type ProcessHandle,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
} from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  FAILURES,
  LIST_ARGV,
  LOCKED,
  Lab,
  OPEN_LOCK,
  READ_LIMIT_MS,
  UDID_A,
  UDID_B,
  expireAfter,
  listDocument,
  listed,
  lockArgv,
  lockDocument,
  turns,
  waitForCalls,
} from "./test-physical.js";

class LockReadsTakeTime implements ProcessRunner {
  constructor(
    private readonly inner: ScriptedProcessRunner,
    private readonly clock: FakeClock,
    private readonly takesMs: number,
  ) {}

  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult> {
    return this.spawn(command, args, options).wait();
  }

  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle {
    const handle = this.inner.spawn(command, args, options);
    if (!args.includes("lockState")) return handle;
    return {
      kill: (signal) => {
        handle.kill(signal);
      },
      pid: handle.pid,
      stderr: handle.stderr,
      stdout: handle.stdout,
      unref: () => {
        handle.unref();
      },
      wait: () =>
        new Promise<ProcessResult>((resolve, reject) => {
          this.clock.setTimer(this.takesMs, () => {
            handle.wait().then(resolve, reject);
          });
        }),
    };
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    return this.inner.spawnStreaming(command, args, options);
  }
}

const PHONE_LOCK_READ_FAILURES = FAILURES.filter((failure) => !failure.expires);

const UDID_C = "00008110-00000000000C";

const UDID_D = "00008110-00000000000D";

describe("IosSimctlDriver physical handler: listAttachedPhysical", () => {
  it("lists the wired phones in any pairing state, once each, none on the network, on this machine or simulated, and throws when the list read times out, exits non-zero or has no result.devices", async () => {
    const lab = new Lab().list([
      listed(UDID_B, { pairingState: "unpaired" }),
      listed(UDID_A),
      listed(UDID_A, { transportType: "localNetwork" }),
      listed(UDID_C, { transportType: "localNetwork" }),
      listed(UDID_D, { transportType: "sameMachine" }),
      listed("00008110-00000000000E", { reality: "simulated" }),
    ]);

    const attached = await (await lab.driver()).listAttachedPhysical();

    expect(attached).toEqual([UDID_A, UDID_B]);
    expect(lab.calls()).toEqual([LIST_ARGV]);

    const document = listDocument([listed(UDID_A)]);
    const reads = [
      {
        lab: new Lab().list([], { file: document, hangs: true }),
        reason: /timed out after 30000ms/,
      },
      { lab: new Lab().list([], { exit: 1, file: document }), reason: /exited 1/ },
      { lab: new Lab().list('{"result":{}}'), reason: /no result\.devices list/ },
    ];
    for (const { lab, reason } of reads) {
      const pending = (await lab.driver()).listAttachedPhysical();

      const settled = reason.test("timed out after 30000ms")
        ? expireAfter(lab, pending, 1, READ_LIMIT_MS)
        : pending;

      await expect(settled).rejects.toThrow(reason);
    }
  });
});

describe("IosSimctlDriver physical handler: presence", () => {
  it("listPresentPhysical answers a paired, wired, unlocked given iPhone present, with its OS version", async () => {
    const lab = new Lab().list([listed(UDID_A)]).lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A]);

    expect(result).toEqual([{ driverDeviceId: UDID_A, osVersion: "18.4", present: true }]);
  });

  it("listPresentPhysical answers a paired, wired, unlocked given iPhone with no reality present", async () => {
    const lab = new Lab().list([listed(UDID_A, { reality: undefined })]).lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A]);

    expect(result).toEqual([{ driverDeviceId: UDID_A, osVersion: "18.4", present: true }]);
  });

  it("listPresentPhysical answers a wired, paired, simulated entry not present not-present, with no lock read", async () => {
    const lab = new Lab().list([listed(UDID_A, { reality: "simulated" })]);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A]);

    expect(result).toEqual([{ driverDeviceId: UDID_A, present: false, reason: "not-present" }]);
    expect(lab.calls()).toEqual([LIST_ARGV]);
  });

  it("listPresentPhysical answers a locked iPhone not present locked, an unpaired one untrusted, and a Wi-Fi-only one and one not listed not-present", async () => {
    const lab = new Lab()
      .list([
        listed(UDID_A),
        listed(UDID_B, { pairingState: "unpaired" }),
        listed(UDID_C, { transportType: "localNetwork" }),
      ])
      .lock(UDID_A, { file: LOCKED });

    const result = await (await lab.driver()).listPresentPhysical([UDID_A, UDID_B, UDID_C, UDID_D]);

    expect(result).toMatchObject([
      { driverDeviceId: UDID_A, present: false, reason: "locked" },
      { driverDeviceId: UDID_B, present: false, reason: "untrusted" },
      { driverDeviceId: UDID_C, present: false, reason: "not-present" },
      { driverDeviceId: UDID_D, present: false, reason: "not-present" },
    ]);
    expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(UDID_A)]);
  });

  it("listPresentPhysical gives no entry for, and never runs a lock read for, a physical device not among the UDIDs it was given", async () => {
    const lab = new Lab().list([listed(UDID_A), listed(UDID_B)]).lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A]);

    expect(result).toMatchObject([{ driverDeviceId: UDID_A, present: true }]);
    expect(result).toHaveLength(1);
    expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(UDID_A)]);
  });

  it("listPresentPhysical ignores a list entry with no udid: it runs no lock read for it, and every given UDID reads as it would without that entry", async () => {
    const lab = new Lab()
      .list([
        listed(UDID_A, { udid: undefined }),
        listed(UDID_A),
        listed(UDID_B, { udid: undefined }),
      ])
      .lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A, UDID_B]);

    expect(result).toMatchObject([
      { driverDeviceId: UDID_A, present: true },
      { driverDeviceId: UDID_B, present: false, reason: "not-present" },
    ]);
    expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(UDID_A)]);
  });

  it("listPresentPhysical of a given UDID listed once over Wi-Fi and once wired reads the wired entry; one listed wired twice reads not-present with no lock read", async () => {
    const lab = new Lab()
      .list([
        listed(UDID_A, { osVersionNumber: "17.0", transportType: "localNetwork" }),
        listed(UDID_A),
        listed(UDID_B),
        listed(UDID_B),
      ])
      .lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A, UDID_B]);

    expect(result).toMatchObject([
      { driverDeviceId: UDID_A, osVersion: "18.4", present: true },
      { driverDeviceId: UDID_B, present: false, reason: "not-present" },
    ]);
    expect(lab.calls()).toEqual([LIST_ARGV, lockArgv(UDID_A)]);
  });

  it.each(FAILURES)(
    "listPresentPhysical whose list read $title answers every given UDID not present not-present, and does not reject",
    async (failure) => {
      const lab = new Lab().list([listed(UDID_A), listed(UDID_B)], {
        ...failure.script(listDocument([listed(UDID_A), listed(UDID_B)])),
      });
      const driver = await lab.driver();
      const pending = driver.listPresentPhysical([UDID_A, UDID_B]);

      const result = await expireAfter(
        lab,
        pending,
        failure.expires ? 1 : 0,
        failure.expires ? READ_LIMIT_MS : 0,
      );

      expect(result).toMatchObject([
        { driverDeviceId: UDID_A, present: false, reason: "not-present" },
        { driverDeviceId: UDID_B, present: false, reason: "not-present" },
      ]);
      expect(lab.timeouts()).toEqual([READ_LIMIT_MS]);
    },
  );

  it("one lock read past 30 s answers that device not present not-present and the others as read", async () => {
    const lab = new Lab()
      .list([listed(UDID_A), listed(UDID_B)])
      .lock(UDID_A, { file: OPEN_LOCK, hangs: true })
      .lock(UDID_B);
    const driver = await lab.driver();

    const result = await expireAfter(
      lab,
      driver.listPresentPhysical([UDID_A, UDID_B]),
      3,
      READ_LIMIT_MS,
    );

    expect(result).toMatchObject([
      { driverDeviceId: UDID_A, present: false, reason: "not-present" },
      { driverDeviceId: UDID_B, osVersion: "18.4", present: true },
    ]);
    expect(lab.timeouts()).toEqual([READ_LIMIT_MS, READ_LIMIT_MS, READ_LIMIT_MS]);
  });

  it.each([
    ...PHONE_LOCK_READ_FAILURES.map((failure) => ({
      script: failure.script(OPEN_LOCK),
      title: failure.title,
    })),
    {
      script: { file: lockDocument({ passcodeRequired: "false" }) },
      title: "lacks a boolean passcodeRequired",
    },
  ])("a lock read that $title answers that device not present not-present", async ({ script }) => {
    const lab = new Lab()
      .list([listed(UDID_A), listed(UDID_B)])
      .lock(UDID_A, script)
      .lock(UDID_B);

    const result = await (await lab.driver()).listPresentPhysical([UDID_A, UDID_B]);

    expect(result).toMatchObject([
      { driverDeviceId: UDID_A, present: false, reason: "not-present" },
      { driverDeviceId: UDID_B, present: true },
    ]);
  });

  it("two lock reads that each take 25 s (fake clock) both finish, and listPresentPhysical resolves before 30 s have passed after the list read: they run in parallel", async () => {
    const lab = new Lab()
      .list([listed(UDID_A), listed(UDID_B)])
      .lock(UDID_A)
      .lock(UDID_B);
    const driver = await lab.driver(new LockReadsTakeTime(lab.runner, lab.clock, 25_000));
    const pending = driver.listPresentPhysical([UDID_A, UDID_B]);
    const state = promiseState(pending);
    void pending.catch(() => undefined);

    await waitForCalls(lab.runner, 3);
    lab.clock.advance(25_000);
    await turns(5);

    expect(state.state).toBe("fulfilled");
    expect(await pending).toMatchObject([
      { driverDeviceId: UDID_A, present: true },
      { driverDeviceId: UDID_B, present: true },
    ]);
  });

  it("a list entry for a given UDID with no osVersionNumber answers that UDID not present not-present", async () => {
    const lab = new Lab()
      .list([listed(UDID_B), listed(UDID_A, { osVersionNumber: undefined })])
      .lock(UDID_B)
      .lock(UDID_A);

    const result = await (await lab.driver()).listPresentPhysical([UDID_B, UDID_A]);

    expect(result).toMatchObject([
      { driverDeviceId: UDID_B, osVersion: "18.4", present: true },
      { driverDeviceId: UDID_A, present: false, reason: "not-present" },
    ]);
  });
});
