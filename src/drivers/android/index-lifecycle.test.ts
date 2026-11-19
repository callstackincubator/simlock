import { describe, expect, it, vi } from "vitest";
import { promiseState } from "../../test-support/promise-state.js";
import {
  FakeClock,
  FakeTcpProbe,
  MemoryFilesystem,
  type ProcessResult,
  type ProcessRunner,
} from "../../ports/index.js";
import {
  answeringAvdPath,
  androidFilesystem,
  avdDirectory,
  binaries,
  bootProbes,
  EmulatorExitingRunner,
  adbServerPort,
  scopedEnv,
  provisionedHarness,
  createDriver,
  EmulatorHost,
  RecordingRunner,
  consolePortOf,
  ok,
  WorkingDirectoryFilesystem,
} from "./testing.js";
import { home } from "./test-index.js";

// why: The emulator outlives the daemon, so it is spawned detached; its output goes to the log file in its AVD folder.
const emulatorOptions = {
  env: { ...scopedEnv, ANDROID_EMU_CRASH_REPORTING_DATABASE: `${avdDirectory}/emu-crash.db` },
  killChildren: true,
  outlivesCaller: true,
  stdio: { file: `${avdDirectory}/simlock_one/simlock.avd/emulator.log` },
} as const;

function recordKillTimeout(
  into: (number | undefined)[],
  command: string,
  args: readonly string[],
  timeoutMs: number | undefined,
): void {
  if (command === binaries.adb && args.slice(2).join(" ") === "emu kill") into.push(timeoutMs);
}

/** why: tells a test what is running when a path is removed, so "stopped before deleted" is observed, not assumed. */
class RemovalObservingFilesystem extends MemoryFilesystem {
  onRemove: (path: string) => void = () => undefined;

  override async rm(path: string): Promise<void> {
    this.onRemove(path);
    await super.rm(path);
  }
}

/**
 * why: An `EmulatorHost` on which another emulator takes a device's console port just before the
 * device's own emulator is spawned on it, and which answers the queries that tell emulators
 * apart: `emu avd path`, `emu avd name` and `getprop ro.boot.qemu.avd_name`.
 *
 * The device's emulator cannot bind the taken port and exits -- but not before the other
 * emulator has answered the readiness poll, as it does on a real machine, where the other
 * emulator answers at once and the spawned one checks its ports only once it has started.
 * So in this fake its exit is seen only once it is killed: a driver that waited for that
 * exit would already have readied the device.
 */
class PortTakingMachine {
  readonly #inner: ProcessRunner;
  readonly #otherPaths = new Map<number, string>();
  #takeOnNextBoot: ((port: number) => void) | undefined;

  constructor(private readonly host: EmulatorHost) {
    this.#inner = host.runner();
  }

  avdPathAnswering(serial: string | undefined): string | undefined {
    const path = this.host.pathAnswering(serial);
    if (path === undefined) return undefined;
    return this.#otherPaths.get(consolePortOf(serial)) ?? path;
  }

  takePortOnNextBoot(avdPath: string): {
    observed(): { running: boolean; sentByDriver: string[] };
  } {
    let running = false;
    let port = Number.NaN;
    const sent: string[] = [];
    this.#takeOnNextBoot = (taken) => {
      port = taken;
      const avdName = /([^/]+)\.avd$/.exec(avdPath)?.[1] ?? "";
      const handle = this.#inner.spawn(
        binaries.emulator,
        ["-avd", avdName, "-port", String(taken)],
        emulatorOptions,
      );
      running = true;
      void handle.wait().then(() => {
        running = false;
      });
      this.#otherPaths.set(taken, avdPath);
    };
    this.#sentTo = (serial, command) => {
      if (consolePortOf(serial) === port && running && !QUERIES.test(command)) sent.push(command);
    };
    return { observed: () => ({ running, sentByDriver: sent }) };
  }

  #sentTo: (serial: string, command: string) => void = () => undefined;

  runner(): ProcessRunner {
    return {
      run: async (command, args, options) => {
        if (command === binaries.adb && args[0] === "-s") {
          const serial = args[1] ?? "";
          const rest = args.slice(2).join(" ");
          this.#sentTo(serial, rest);
          const answer = this.#identity(serial, rest);
          if (answer !== undefined) return answer;
        }
        return this.#inner.run(command, args, options);
      },
      spawn: (command, args, options) => {
        const take = this.#takeOnNextBoot;
        if (take === undefined || command !== binaries.emulator) {
          return this.#inner.spawn(command, args, options);
        }
        this.#takeOnNextBoot = undefined;
        take(Number(args[args.indexOf("-port") + 1]));
        const handle = this.#inner.spawn(command, args, options);
        let killed!: () => void;
        const exitSeen = new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          ...handle,
          kill: (signal) => {
            handle.kill(signal);
            killed();
          },
          wait: async () => {
            await exitSeen;
            return handle.wait();
          },
        };
      },
      spawnStreaming: (command, args, options) =>
        this.#inner.spawnStreaming(command, args, options),
    };
  }

  #identity(serial: string, command: string): ProcessResult | undefined {
    const path = this.avdPathAnswering(serial);
    if (path === undefined) return undefined;
    const name = /([^/]+)\.avd$/.exec(path)?.[1] ?? "";
    if (command === "emu avd path") return ok(`${path}\nOK\n`);
    if (command === "emu avd name") return ok(`${name}\nOK\n`);
    if (command === "shell getprop ro.boot.qemu.avd_name") return ok(`${name}\n`);
    return undefined;
  }
}

/** why: `emu avd path` answers truthfully until the test sets an answer, so a seed is made first and only the copy's boot is lied to. */
function overridingAvdPath(inner: ProcessRunner): {
  readonly answer: (answer: ProcessResult) => void;
  readonly runner: ProcessRunner;
} {
  let answer: ProcessResult | undefined;
  return {
    answer: (next) => {
      answer = next;
    },
    runner: {
      run: async (command, args, options) =>
        answer !== undefined &&
        command === binaries.adb &&
        args[0] === "-s" &&
        args.slice(2).join(" ") === "emu avd path"
          ? answer
          : inner.run(command, args, options),
      spawn: (command, args, options) => inner.spawn(command, args, options),
      spawnStreaming: (command, args, options) => inner.spawnStreaming(command, args, options),
    },
  };
}

class LinkedHomeFilesystem extends MemoryFilesystem {
  override async realpath(path: string): Promise<string> {
    const resolved = await super.realpath(path.replace(/^\/private\/home\//, "/home/"));
    return resolved.replace(/^\/home\//, "/private/home/");
  }
}

const QUERIES = /^(shell getprop \S+|emu avd (name|path|id|status|discoverypath))$/;

/**
 * why: The message of the driver's `DriverCrashError`; anything else -- a boot timeout, the fake's
 * own complaint about an unscripted call -- is rethrown, so it fails the test as itself.
 */
function driverCrashMessage(error: unknown): { readonly refused: string } {
  if (error instanceof Error && error.name === "DriverCrashError") {
    return { refused: error.message };
  }
  throw error;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("AndroidDriver readiness on a taken console port", () => {
  it("refuses to ready a device whose serial an emulator of an AVD outside its root answers, and changes nothing on that emulator, even when the device is then shut down (#256)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const machine = new PortTakingMachine(host);
    const driver = await createDriver(filesystem, machine.runner(), { ids: ["one"] });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);

    // why: Another emulator takes the device's console port before its own emulator binds it --
    // whatever freed the port for it (#52, a second Simlock instance, the user's own
    // emulator). Its AVD is named like Simlock's but lives in the user's AVD home: a name
    // proves nothing, root membership does (safety rule 8).
    const otherPath = `${home}/.android/avd/simlock_one.avd`;
    const other = machine.takePortOnNextBoot(otherPath);

    const readied = await driver.makeReady(stopped).then(
      (ready) => machine.avdPathAnswering(ready.address),
      (error: unknown) => driverCrashMessage(error),
    );
    // why: What the core does with a device whose boot failed: it destroys it, and destroying a
    // device starts by shutting it down.
    await driver.shutdown(stopped);

    const ownPath = `${avdDirectory}/simlock_one/simlock.avd`;
    expect({ readied, other: other.observed() }).toEqual({
      readied: {
        refused: expect.stringMatching(
          new RegExp(`"${escapeRegExp(otherPath)}".* ${escapeRegExp(ownPath)}(\\s|$)`),
        ),
      },
      other: { running: true, sentByDriver: [] },
    });
  });

  it.each<{
    readonly reported: string;
    readonly answer: string;
    readonly filesystem?: () => MemoryFilesystem;
  }>([
    { answer: `${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`, reported: "exactly" },
    {
      answer: `${avdDirectory}/simlock_one/simlock.avd/\r\nOK\r\n`,
      reported: "with a trailing slash",
    },
    {
      answer: `/private${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`,
      reported: "through a link to the device root's directory",
    },
    // why: `/home` is a link to `/private/home`, as macOS's `/var` is to `/private/var`: the link
    // is on the device root's side, and the emulator answers with the resolved path.
    {
      answer: `/private${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`,
      filesystem: () => new LinkedHomeFilesystem(),
      reported: "resolved, when the device root's own path runs through a link",
    },
  ])(
    "readies a device whose emulator reports its AVD directory $reported",
    async ({ answer, filesystem: createFilesystem, reported }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (createFilesystem === undefined) filesystem.defineSymlink("/private/home", "/home");
      const host = new EmulatorHost(filesystem);
      const override = overridingAvdPath(host.runner());
      const driver = await createDriver(filesystem, override.runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      const device = await driver.provision(spec);
      override.answer(ok(answer));
      if (reported === "exactly") {
        // why: An exact answer needs nothing from the filesystem: a directory that cannot be
        // resolved this moment does not fail the boot.
        filesystem.defineFailure(`${avdDirectory}/simlock_one/simlock.avd`, "EACCES");
      }

      const ready = await driver.makeReady(device);

      expect(ready.address).toBe("emulator-5586");
    },
  );

  it.each<{
    readonly answered: string;
    readonly answer: ProcessResult;
    readonly filesystem?: () => MemoryFilesystem;
    readonly existing?: string;
  }>([
    { answer: ok("KO: unknown command\r\n"), answered: "a console error" },
    {
      answer: { code: 1, stderr: "error: could not connect to console", stdout: "" },
      answered: "a failed adb call",
    },
    {
      answer: ok(`/private/elsewhere/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "a directory that does not exist",
    },
    {
      answer: ok(`${avdDirectory}/simlock_two/simlock.avd\r\nOK\r\n`),
      answered: "another device's directory in the same root",
      existing: `${avdDirectory}/simlock_two/simlock.avd`,
    },
    {
      answer: ok(`${home}/.android/avd/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "a directory of the same name outside the root",
      existing: `${home}/.android/avd/simlock_one/simlock.avd`,
    },
    {
      answer: ok(`\r\n${avdDirectory}/simlock_one/simlock.avd\r\nOK\r\n`),
      answered: "its own directory below a blank first line",
    },
    {
      // why: Resolved against the daemon's working directory, which here is the device root, a
      // relative answer would name the device's own directory -- by accident.
      answer: ok("simlock_one/simlock.avd\r\nOK\r\n"),
      answered: "a relative path",
      filesystem: () => new WorkingDirectoryFilesystem(avdDirectory),
    },
  ])(
    "refuses to ready a device whose emulator answers the AVD path query with $answered, and stops that emulator",
    async ({ answer, existing, filesystem: createFilesystem }) => {
      const filesystem = await androidFilesystem({}, createFilesystem?.());
      if (existing !== undefined) await filesystem.mkdirp(existing);
      const host = new EmulatorHost(filesystem);
      const override = overridingAvdPath(host.runner());
      const driver = await createDriver(filesystem, override.runner, { ids: ["one"] });
      const spec = await driver.resolveSpec({
        model: "Pixel 5",
        osVersion: "34",
        platform: "android",
      });
      const device = await driver.provision(spec);
      override.answer(answer);

      const readied = await driver.makeReady(device).then(
        () => "readied",
        (error: unknown) => driverCrashMessage(error),
      );

      expect({ readied, running: host.avdAnswering("emulator-5586") }).toEqual({
        readied: { refused: expect.any(String) },
        running: undefined,
      });
    },
  );
});

describe("AndroidDriver emulator registration", () => {
  it("sweeps its own console range when it takes over a server, and nobody else's", async () => {
    // why: A running emulator announced itself exactly once, to a server a previous daemon has
    // since reaped. With `ADB_EMU=0` nothing rediscovers it, so `simlock daemon stop` would
    // otherwise orphan gigabytes of RSS the driver can no longer see, and hand the console
    // port it is sitting on to the next emulator, which then cannot bind.
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    await createDriver(filesystem, new EmulatorExitingRunner([]), { tcpProbe });

    const announced = tcpProbe.sends.map((send) => send.payload);
    expect(announced).toHaveLength(49);
    expect(announced[0]).toBe("0012host:emulator:5587");
    expect(announced.at(-1)).toBe("0012host:emulator:5683");
    // why: Every send goes to Simlock's own server, and every port is inside Simlock's range:
    // one below 5587 would be adb connecting to an emulator of the user's.
    expect(tcpProbe.sends.every((send) => send.port === adbServerPort)).toBe(true);
  });

  it("finishes the sweep when a port refuses the announcement", async () => {
    const filesystem = await androidFilesystem();
    const tcpProbe = new FakeTcpProbe([adbServerPort]);
    tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(
      createDriver(filesystem, new EmulatorExitingRunner([]), { tcpProbe }),
    ).resolves.toBeDefined();
    expect(tcpProbe.sends).toHaveLength(49);
  });

  it("re-announces an emulator that stays unreachable, since nothing else will", async () => {
    const harness = await provisionedHarness({ initialAdbFailures: 2 });
    // why: Nothing is announced when an emulator is spawned: adb answers `host:emulator:<port>`
    // by connecting out to that port, and the emulator has not opened it yet.
    const afterSweep = harness.tcpProbe.sends.length;
    const probedBefore = bootProbes(harness.runner);
    const ready = harness.driver.makeReady(harness.device);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(probedBefore + 1));
    expect(harness.tcpProbe.sends).toHaveLength(afterSweep);

    // why: Past the grace period on the second failure: adb's own reconnect queue is drained by
    // the scanner thread, which `ADB_EMU=0` does not run.
    harness.clock.advance(6_000);
    await vi.waitFor(() => expect(bootProbes(harness.runner)).toBe(probedBefore + 2));
    await vi.waitFor(() =>
      expect(harness.tcpProbe.sends.slice(afterSweep)).toEqual([
        { payload: "0012host:emulator:5587", port: adbServerPort },
      ]),
    );

    harness.clock.advance(2_000);
    await expect(ready).resolves.toMatchObject({ address: "emulator-5586" });
  });

  it("never fails a boot because a registration failed", async () => {
    const harness = await provisionedHarness();
    harness.tcpProbe.failSendsWith(new Error("connect ECONNREFUSED"));

    await expect(harness.driver.makeReady(harness.device)).resolves.toMatchObject({
      deviceId: "simlock_one",
    });
  });
});

describe("AndroidDriver console ports across a restart", () => {
  it("stops a discovered running emulator before deleting its AVD after a restart", async () => {
    const filesystem = new RemovalObservingFilesystem();
    await androidFilesystem({}, filesystem);
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runningAtDeletion: (string | undefined)[] = [];
    const killTimeouts: (number | undefined)[] = [];
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        recordKillTimeout(killTimeouts, command, args, options?.timeoutMs);
        return inner.run(command, args, options);
      },
    };
    filesystem.onRemove = (path) => {
      if (path === `${avdDirectory}/${running.deviceId}`) {
        runningAtDeletion.push(host.avdAnswering(running.address));
      }
    };
    const after = await createDriver(filesystem, runner);
    const reality = await after.listManaged();
    const orphan = reality.devices[0]!;
    expect(orphan).toMatchObject({ deviceId: running.deviceId, runState: "running" });
    expect(host.avdAnswering(running.address)).toBe(running.deviceId);

    await after.destroy(orphan);

    expect(runningAtDeletion, "the emulator must have exited before AVD deletion").toEqual([
      undefined,
    ]);
    expect(killTimeouts, "the kill must be bounded").toEqual([5_000]);
    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}`)).toBe(false);
  });

  it("refuses to delete the AVD of a discovered emulator that does not exit", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const inner = host.runner();
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) =>
        args.includes("kill") ? ok() : inner.run(command, args, options),
    };
    const clock = new FakeClock();
    const after = await createDriver(filesystem, runner, { bootTimeoutMs: 600_000, clock });
    const orphan = (await after.listManaged()).devices[0]!;

    const destroyed = after.destroy(orphan);
    const refused = expect(destroyed).rejects.toThrow("did not exit");
    const state = promiseState(destroyed);
    await vi.waitFor(() => expect(clock.pendingTimerCount).toBeGreaterThan(0));
    // why: each poll arms the next delay only after the previous one fired, so the clock moves in steps.
    for (let elapsed = 0; elapsed < 179_999; elapsed += 1_000) {
      clock.advance(Math.min(1_000, 179_999 - elapsed));
      for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
    }
    expect(state.state, "still waiting just before 180 s, whatever the boot deadline").toBe(
      "pending",
    );
    clock.advance(1);
    await refused;

    expect(await filesystem.exists(`${avdDirectory}/${running.deviceId}`)).toBe(true);
  });

  it("refuses to delete the AVD when an attached emulator cannot say which AVD it runs", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const calls: { args: readonly string[]; timeoutMs: number | undefined }[] = [];
    const inner = answeringAvdPath(binaries.adb, host.runner(), {
      code: 1,
      stderr: "error",
      stdout: "",
    });
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (command === binaries.adb) calls.push({ args, timeoutMs: options?.timeoutMs });
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner);
    const orphan = (await after.listManaged()).devices[0]!;

    await expect(after.destroy(orphan)).rejects.toThrow("could not tell which AVD");

    expect({
      kills: calls.filter((call) => call.args.includes("kill")).length,
      probeTimeoutMs: calls.find((call) => call.args.includes("path"))?.timeoutMs,
      kept: await filesystem.exists(`${avdDirectory}/${running.deviceId}`),
      running: host.avdAnswering(running.address),
    }).toEqual({ kills: 0, probeTimeoutMs: 5_000, kept: true, running: running.deviceId });
  });

  it("never kills an emulator that runs a different AVD when deleting a discovered one", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    const spec = await before.resolveSpec({ model: "Pixel 5", platform: "android" });
    const running = await before.makeReady(await before.provision(spec));
    const kills: string[] = [];
    const inner = answeringAvdPath(
      binaries.adb,
      host.runner(),
      ok(`${avdDirectory}/simlock_other.avd\nOK\n`),
    );
    const runner: ProcessRunner = {
      ...inner,
      run: async (command, args, options) => {
        if (args.includes("kill")) kills.push(args.join(" "));
        return inner.run(command, args, options);
      },
    };
    const after = await createDriver(filesystem, runner);
    const orphan = (await after.listManaged()).devices[0]!;

    await after.destroy(orphan);

    expect({ kills, running: host.avdAnswering(running.address) }).toEqual({
      kills: [],
      running: running.deviceId,
    });
  });

  it("a shutdown after a restart sends no kill, snapshot load or rule removal to another device on the stored serial (#284)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const runner = new RecordingRunner(host.runner());
    const after = await createDriver(filesystem, runner, { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    expect(running.address).toBe(stopped.address);
    expect(host.avdAnswering(running.address)).toBe("simlock_two");
    const callStart = runner.calls.length;

    await after.shutdown(stopped).then(() => undefined, driverCrashMessage);

    expect({
      running: host.avdAnswering(running.address),
      ruleCalls: runner.calls
        .slice(callStart)
        .filter(
          (call) =>
            call.args.includes(running.address) &&
            (call.args.includes("reverse") || call.args.includes("forward")),
        )
        .map((call) => call.args),
      mutations: runner.calls
        .slice(callStart)
        .filter(
          (call) =>
            call.command === binaries.adb &&
            call.args[1] === running.address &&
            (call.args.slice(2).join(" ") === "emu kill" ||
              call.args.slice(2, 6).join(" ") === "emu avd snapshot load"),
        )
        .map((call) => call.args),
    }).toEqual({ running: "simlock_two", ruleCalls: [], mutations: [] });
  });

  it("sends no kill when the stored serial's identity cannot be read, and gives the probe a timeout (#284)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const inner = host.runner();
    let unreachable = false;
    const runner = new RecordingRunner({
      run: async (command, args, options) =>
        unreachable && command === binaries.adb && args.slice(2).join(" ") === "emu avd path"
          ? { code: 1, stderr: "unreachable", stdout: "" }
          : await inner.run(command, args, options),
      spawn: (...args) => inner.spawn(...args),
      spawnStreaming: (...args) => inner.spawnStreaming(...args),
    });
    const after = await createDriver(filesystem, runner, { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    unreachable = true;
    const callStart = runner.calls.length;

    await after.shutdown(stopped).catch(() => undefined);

    const calls = runner.calls.slice(callStart);
    expect(calls.filter((call) => call.args.slice(2).join(" ") === "emu kill")).toEqual([]);
    expect(host.avdAnswering(running.address)).toBe("simlock_two");
    expect(
      calls.find((call) => call.args.slice(2).join(" ") === "emu avd path")?.options.timeoutMs,
    ).toBeGreaterThan(0);
  });

  it("readies a stopped device and one provisioned after a restart each at an address its own emulator answers (#52)", async () => {
    const spec = {
      physical: false,
      model: "Pixel 5",
      osVersion: "34",
      platform: "android",
    } as const;
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);

    // why: The first daemon: provision, boot and stop a device. Stopped, it holds its console
    // port only in its driver data -- nothing is listening there any more. Each call gets
    // the device as the last one returned it, which is what the registry commits.
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);

    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const provisioned = await after.provision(spec);
    const readyProvisioned = await after.makeReady(provisioned);
    const readyStopped = await after.makeReady(stopped);

    expect({
      provisioned: host.avdAnswering(readyProvisioned.address),
      stopped: host.avdAnswering(readyStopped.address),
    }).toEqual({ provisioned: "simlock_two", stopped: "simlock_one" });
  });
});

describe("AndroidDriver console port reservations", () => {
  const spec = { physical: false, model: "Pixel 5", osVersion: "34", platform: "android" } as const;

  it("keeps a device's console port across its stops, so a call on its stopped record reaches no other device", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    // why: The first provision makes the seed, which takes the id after its device's; each boot's mark write takes the next.
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "seed", "mark-1", "two", "mark-2", "mark-3"],
    });
    await driver.resolveSpec(spec);
    const stopped = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(stopped);
    const running = await driver.makeReady(await driver.provision(spec));

    await driver.shutdown(stopped);

    expect({
      rebooted: (await driver.makeReady(stopped)).address,
      running: host.avdAnswering(running.address),
    }).toEqual({ rebooted: stopped.address, running: "simlock_two" });
  });

  it("gives a deleted device's console port back to the next boot", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const driver = await createDriver(filesystem, host.runner(), {
      ids: ["one", "mark-1", "two", "mark-2"],
    });
    await driver.resolveSpec(spec);
    const deleted = await driver.makeReady(await driver.provision(spec));
    await driver.shutdown(deleted);
    await driver.destroy(deleted);

    const next = await driver.makeReady(await driver.provision(spec));

    expect(next.address).toBe(deleted.address);
  });

  it("never stops the emulator now on a stopped device's old console port when deleting that device after a restart", async () => {
    const filesystem = await androidFilesystem();
    const host = new EmulatorHost(filesystem);
    const before = await createDriver(filesystem, host.runner(), { ids: ["one"] });
    await before.resolveSpec(spec);
    const stopped = await before.makeReady(await before.provision(spec));
    await before.shutdown(stopped);
    const after = await createDriver(filesystem, host.runner(), { ids: ["two"] });
    await after.resolveSpec(spec);
    const running = await after.makeReady(await after.provision(spec));
    // why: Nothing reserves a stopped device's port after a restart, so the next boot took it.
    expect(running.address).toBe(stopped.address);

    await after.destroy(stopped);

    expect(host.avdAnswering(running.address)).toBe("simlock_two");
  });
});
