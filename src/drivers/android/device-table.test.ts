import { describe, expect, it } from "vitest";

import {
  FakeClock,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type ScriptedProcessExpectation,
} from "../../ports/index.js";
import { AdbTools } from "./adb-tools.js";
import { AvdConfig } from "./avd-config.js";
import { DeviceTable } from "./device-table.js";
import { Ownership } from "./ownership.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  ANDROID_SDK_ROOT as sdk,
  answeringAvdPath,
  processResult,
} from "./testing.js";

const avdDirectory = "/home/simlock/.simlock/devices/android";
const binaries = {
  adb: `${sdk}/platform-tools/adb`,
  avdmanager: `${sdk}/cmdline-tools/latest/bin/avdmanager`,
  emulator: `${sdk}/emulator/emulator`,
} as const;
const env = { ANDROID_HOME: sdk } as const;

function createTable(
  filesystem: MemoryFilesystem = new MemoryFilesystem(),
  processRunner: ProcessRunner = new ScriptedProcessRunner([]),
  clock: FakeClock = new FakeClock(),
): DeviceTable {
  const adbTools = new AdbTools({
    adb: binaries.adb,
    adbServerPort: 5038,
    baseEnv: env,
    clock,
    deviceRoot: avdDirectory,
    emulator: binaries.emulator,
    processRunner,
  });
  return new DeviceTable({
    adbTools,
    avdConfig: new AvdConfig({
      adb: binaries.adb,
      adbTools,
      filesystem,
      idGenerator: { generate: () => "1" },
      seedLaunchInputs: [],
    }),
    avdmanager: binaries.avdmanager,
    baseEnv: env,
    deviceRoot: avdDirectory,
    filesystem,
    legacyAvdHome: `${home}/.android/avd`,
    ownership: new Ownership({ adb: binaries.adb, adbTools, filesystem }),
    register: async () => undefined,
  });
}

/** why: the device root as a daemon leaves it; `config` is the `config.ini` of the root AVD `simlock_one`. */
async function rootFilesystem(
  options: { readonly config?: string } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(avdDirectory);
  if (options.config !== undefined) {
    await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
    await filesystem.writeFileAtomic(`${avdDirectory}/simlock_one.avd/config.ini`, options.config);
  }
  return filesystem;
}

function ok(stdout = ""): ProcessResult {
  return { code: 0, stderr: "", stdout };
}

/** why: what a running AVD made before copies answers to `emu avd path`: `<root>/<name>.avd`. */
function avdPathExpectation(serial: string, avdName = "simlock_one"): ScriptedProcessExpectation {
  return processResult(
    binaries.adb,
    ["-s", serial, "emu", "avd", "path"],
    `${avdDirectory}/${avdName}.avd\r\nOK\r\n`,
  );
}

/**
 * why: Honours `timeoutMs` the way `NodeProcessRunner` does -- the child is killed once it
 * passes -- but on the driver's fake clock, so a deadline given to `run` is visible to a test
 * that moves that clock. A bare `ScriptedProcessRunner` ignores `timeoutMs`.
 */
class ClockDeadlineRunner extends ScriptedProcessRunner {
  readonly #clock: FakeClock;

  constructor(expectations: readonly ScriptedProcessExpectation[], clock: FakeClock) {
    super(expectations);
    this.#clock = clock;
  }

  override async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    const handle = this.spawn(command, args, options);
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : this.#clock.setTimer(options.timeoutMs, () => {
            handle.kill("SIGKILL");
          });
    try {
      return await handle.wait();
    } finally {
      if (timer !== undefined) this.#clock.cancel(timer);
    }
  }
}

// why: a part of a decomposed module (ADR 0063 §2): these tests build `DeviceTable` directly and prove what it alone makes.
describe("DeviceTable", () => {
  it("starts a second call under one device's lock only after the first ends, and a call on another device does not wait", async () => {
    const table = createTable();
    const events: string[] = [];
    let endFirst!: () => void;
    const firstMayEnd = new Promise<void>((resolve) => {
      endFirst = resolve;
    });

    const first = table.withLock("device-a", async () => {
      events.push("first starts");
      await firstMayEnd;
      events.push("first ends");
    });
    const second = table.withLock("device-a", async () => {
      events.push("second starts");
    });
    const other = table.withLock("device-b", async () => {
      events.push("other starts");
    });
    await other;
    await Promise.resolve();
    const beforeFirstEnds = [...events];
    endFirst();
    await Promise.all([first, second]);

    expect(beforeFirstEnds).toEqual(["first starts", "other starts"]);
    expect(events).toEqual(["first starts", "other starts", "first ends", "second starts"]);
  });

  it("reports one running root AVD, one stopped root AVD and the running AVD's process", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_running.avd`);
    await filesystem.mkdirp(`${avdDirectory}/simlock_stopped.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; head -c 4096 /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        "simlock_running\n",
      ),
      avdPathExpectation("emulator-5586", "simlock_running"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    expect(
      [...reality.devices]
        .map((device) => ({ deviceId: device.deviceId, runState: device.runState }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
    ).toEqual([
      { deviceId: "simlock_running", runState: "running" },
      { deviceId: "simlock_stopped", runState: "stopped" },
    ]);
    expect(reality.processes).toEqual([expect.objectContaining({ deviceId: "simlock_running" })]);
  });

  it("listManaged settles after the timeout when one serial's mark read never answers, reports that serial unreadable, and still finds another serial in the same pass", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_one.avd`);
    await filesystem.mkdirp(`${avdDirectory}/simlock_two.avd`);
    const clock = new FakeClock();
    const runner = new ClockDeadlineRunner(
      [
        processResult(
          binaries.adb,
          ["devices"],
          "List of devices attached\nemulator-5586\tdevice\nemulator-5588\tdevice\n",
        ),
        {
          hangs: true,
          match: {
            args: ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
            command: binaries.adb,
          },
        },
        processResult(
          binaries.adb,
          ["-s", "emulator-5588", "shell", /getprop ro\.boot\.qemu\.avd_name/],
          "simlock_two\n",
        ),
        avdPathExpectation("emulator-5588", "simlock_two"),
      ],
      clock,
    );
    const table = createTable(filesystem, runner, clock);

    let settled: Awaited<ReturnType<typeof table.listManaged>> | undefined;
    void table.listManaged().then((reality) => {
      settled = reality;
    });
    for (let step = 0; step < 20 && settled === undefined; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(1_000);
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      settled?.devices.map((device) => ({ deviceId: device.deviceId, runState: device.runState })),
    ).toEqual(
      expect.arrayContaining([
        { deviceId: "simlock_two", runState: "running" },
        { deviceId: "simlock_one", runState: "transitioning" },
      ]),
    );
    expect(settled?.processes).toEqual([expect.objectContaining({ deviceId: "simlock_two" })]);
  });

  it("reads the erasable mark with head -c 4096, and a mark cut at that cap is read as no mark", async () => {
    const filesystem = await rootFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const cutAtCap = `{"token":"tok-123","pad":"${"x".repeat(5000)}"}`.slice(0, 4096);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; head -c 4096 /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        `simlock_one\n${cutAtCap}`,
      ),
      avdPathExpectation("emulator-5586"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: true,
    });
  });

  it("listManaged passes a 30-second timeout to adb devices", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const table = createTable(filesystem, runner);

    await table.listManaged();

    const listing = runner.calls.find((call) => call.args[0] === "devices");
    expect(listing?.options.timeoutMs).toBe(30_000);
  });

  it("treats an otherwise-stopped AVD as transitioning when an unattributable transitional serial is present", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(
        binaries.adb,
        ["devices"],
        "List of devices attached\nemulator-5588\toffline\n",
      ),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_idle", runState: "transitioning" }),
    ]);
    // why: Only settled `device`-state serials are counted as running processes; the
    // unattributable offline serial never appears here regardless of the AVD fallback above.
    expect(reality.processes).toEqual([]);
  });

  it("still resolves a stopped AVD as stopped when adb reports no serials at all", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_idle.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_idle", runState: "stopped" }),
    ]);
  });

  it("listManaged reports matching durable and erasable marks for a running device", async () => {
    const filesystem = await rootFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; head -c 4096 /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        'simlock_one\n{"token":"tok-123"}',
      ),
      avdPathExpectation("emulator-5586"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: "tok-123",
      erasableReadable: true,
    });
  });

  it("listManaged reports an erased running device when the erasable mark file is gone", async () => {
    const filesystem = await rootFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        [
          "-s",
          "emulator-5586",
          "shell",
          "getprop ro.boot.qemu.avd_name; head -c 4096 /data/local/tmp/simlock-mark.json 2>/dev/null || true",
        ],
        "simlock_one\n",
      ),
      avdPathExpectation("emulator-5586"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: true,
    });
  });

  it("keeps listManaged alive when a serial dies between the scan and the read", async () => {
    const filesystem = await rootFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      {
        match: {
          args: [
            "-s",
            "emulator-5586",
            "shell",
            "getprop ro.boot.qemu.avd_name; head -c 4096 /data/local/tmp/simlock-mark.json 2>/dev/null || true",
          ],
          command: binaries.adb,
        },
        result: { code: 1, stderr: "device 'emulator-5586' not found", stdout: "" },
      },
    ]);
    const table = createTable(filesystem, runner);

    // why: An emulator can vanish between `adb devices` and the read. Losing the whole
    // reality view over one dead serial would strand every other managed device.
    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.runState).toBe("transitioning");
    // why: The durable half is a host file and stays readable; the erasable half genuinely
    // was not read, so it must report unreadable rather than absent -- absent would
    // classify as a foreign erase.
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: false,
    });
  });

  it("listManaged reports erasableReadable: false for a stopped, marked device", async () => {
    const filesystem = await rootFilesystem({
      config: "hw.ramSize=2048\nsimlock.mark=tok-123\n",
    });
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_one");
    expect(device?.mark).toEqual({
      durable: "tok-123",
      erasable: undefined,
      erasableReadable: false,
    });
  });

  it("listManaged reports no mark for a stopped, pre-existing AVD with no durable key (upgrade path)", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_legacy.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    const device = reality.devices.find((candidate) => candidate.deviceId === "simlock_legacy");
    expect(device?.mark).toBeUndefined();
  });

  it("does not attribute an outside-root emulator to a root AVD with the same name (#261)", async () => {
    const filesystem = await rootFilesystem();
    const ownedPath = `${avdDirectory}/simlock_mine.avd`;
    const foreignPath = `${home}/.android/avd/simlock_mine.avd`;
    await filesystem.mkdirp(ownedPath);
    await filesystem.writeFileAtomic(`${ownedPath}/config.ini`, "simlock.mark=owned-token\n");
    await filesystem.mkdirp(foreignPath);

    for (const path of [ownedPath, foreignPath]) {
      const runner = answeringAvdPath(
        binaries.adb,
        new ScriptedProcessRunner([
          processResult(
            binaries.adb,
            ["devices"],
            "List of devices attached\nemulator-5586\tdevice\n",
          ),
          processResult(
            binaries.adb,
            ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
            'simlock_mine\n{"token":"owned-token"}',
          ),
        ]),
        ok(`${path}\r\nOK\r\n`),
      );
      const table = createTable(filesystem, runner);

      const reality = await table.listManaged();

      expect
        .soft(reality.processes, path)
        .toEqual(
          path === ownedPath
            ? [expect.objectContaining({ address: "emulator-5586", deviceId: "simlock_mine" })]
            : [],
        );
      expect.soft(reality.devices, path).toEqual([
        expect.objectContaining({
          deviceId: "simlock_mine",
          runState: path === ownedPath ? "running" : "stopped",
          mark: {
            durable: "owned-token",
            erasable: path === ownedPath ? "owned-token" : undefined,
            erasableReadable: path === ownedPath,
          },
        }),
      ]);
    }
  });

  it("manages every AVD in its root, whatever the AVD is called", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/a-name-nobody-prefixed.avd`);
    await filesystem.mkdirp(`${avdDirectory}/Odd.Name_3.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\n"),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    expect(reality.devices.map((device) => device.deviceId).sort()).toEqual([
      "Odd.Name_3",
      "a-name-nobody-prefixed",
    ]);
  });

  it("ignores a running emulator whose AVD does not live in its root", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${avdDirectory}/simlock_mine.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.adb, ["devices"], "List of devices attached\nemulator-5586\tdevice\n"),
      processResult(
        binaries.adb,
        ["-s", "emulator-5586", "shell", /getprop ro\.boot\.qemu\.avd_name/],
        // why: Named exactly like one of Simlock's, and still not Simlock's: the AVD is not in
        // the root, and ownership is proven from the root rather than from the name or from
        // the fact that Simlock's own server can see it.
        "simlock_impostor\n",
      ),
    ]);
    const table = createTable(filesystem, runner);

    const reality = await table.listManaged();

    expect(reality.processes).toEqual([]);
    expect(reality.devices).toEqual([
      expect.objectContaining({ deviceId: "simlock_mine", runState: "stopped" }),
    ]);
  });

  it("finds an AVD stranded in the pre-root AVD home", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${home}/.android/avd/simlock_old.avd`);
    const table = createTable(filesystem, new ScriptedProcessRunner([]));

    await expect(table.findLegacy("simlock_old")).resolves.toMatchObject({
      device: { deviceId: "simlock_old" },
      path: `${home}/.android/avd/simlock_old.avd`,
    });
    await expect(table.findLegacy("simlock_never_existed")).resolves.toBeUndefined();
  });

  it("deletes a stranded AVD against the legacy AVD home, not Simlock's root", async () => {
    const filesystem = await rootFilesystem();
    await filesystem.mkdirp(`${home}/.android/avd/simlock_old.avd`);
    const runner = new ScriptedProcessRunner([
      processResult(binaries.avdmanager, ["delete", "avd", "-n", "simlock_old"]),
    ]);
    const table = createTable(filesystem, runner);
    const legacy = await table.findLegacy("simlock_old");

    await table.destroyLegacy(legacy!.device);

    // why: Pointed at the home the AVD is actually in, and deliberately carrying no
    // `ANDROID_ADB_SERVER_PORT`: a device this old is not on Simlock's server, and the
    // user's is not one Simlock may drive.
    expect(runner.calls.at(-1)?.options?.env).toEqual({
      ANDROID_AVD_HOME: `${home}/.android/avd`,
      ANDROID_HOME: sdk,
    });
  });
});
