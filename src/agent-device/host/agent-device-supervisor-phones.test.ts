import { describe, expect, it } from "vitest";
import { MemoryFilesystem } from "../../ports/index.js";
import {
  home,
  stateDir,
  recordPath,
  nodePath,
  internalEntry,
  run,
  versionRun,
  daemonSpawn,
  phoneSpawn,
  ownLine,
  record,
  flush,
  advanceBy,
  advancing,
  advanceUntil,
  stateOf,
  unavailable,
  daemonSpawns,
  warnings,
  readJson,
} from "./test-agent-device-supervisor.js";

describe("AgentDeviceSupervisor in the phones role", () => {
  const phonesStateDir = `${home}/agent-device-phones`;
  const signing = {
    bundleId: "com.example.runner",
    provisioningProfile: "Simlock Runner Profile",
    signingIdentity: "Apple Development: Ada (XYZ)",
    teamId: "ABCDE12345",
  };
  const signingEnvironment = {
    AGENT_DEVICE_IOS_BUNDLE_ID: "com.example.runner",
    AGENT_DEVICE_IOS_PROVISIONING_PROFILE: "Simlock Runner Profile",
    AGENT_DEVICE_IOS_SIGNING_IDENTITY: "Apple Development: Ada (XYZ)",
    AGENT_DEVICE_IOS_TEAM_ID: "ABCDE12345",
  };

  it.each([
    ["iOS and Android on, keys set", ["ios", "android"], signing, signingEnvironment],
    ["iOS and Android on, keys unset", ["ios", "android"], undefined, {}],
    [
      "iOS off: the empty private set directory",
      ["android"],
      signing,
      {
        ...signingEnvironment,
        AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET: `${phonesStateDir}/no-ios-devices`,
      },
    ],
    [
      "Android off: the allowlist sentinel",
      ["ios"],
      undefined,
      { AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: "simlock-no-android-device" },
    ],
  ] as const)(
    "spawns the phone daemon with its own state directory, policy file, pid record and marker suffix, no simulator set and no driver lease key, adb on 5037 and the configured AGENT_DEVICE_IOS_ keys: %s",
    async (_case, platforms, ios, signingKeys) => {
      const harness = await run({
        baseEnvironment: {
          ANDROID_ADB_SERVER_ADDRESS: "operator-host",
          ANDROID_ADB_SERVER_PORT: "5038",
          ANDROID_SERIAL: "emulator-5554",
          HOME: "/home/operator",
          PATH: "/usr/local/bin:/usr/bin",
        },
        driverEnvironment: {
          ANDROID_ADB_SERVER_PORT: "5038",
          SIMLOCK_IOS_DEVICE_SET: "/devices/ios",
        },
        expectations: [versionRun(), phoneSpawn()],
        ...(ios === undefined ? {} : { ios }),
        platforms,
        role: "phones",
      });

      expect(daemonSpawns(harness)).toEqual([
        [nodePath, internalEntry, `--simlock-home=${home}`, "--simlock-role=phones"],
      ]);
      expect(harness.runner.calls[1]?.options.env).toEqual({
        AGENT_DEVICE_CLAIMS_DIR: `${phonesStateDir}/device-claims`,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
        AGENT_DEVICE_DAEMON_POLICY: `${phonesStateDir}/policy.json`,
        AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
        AGENT_DEVICE_LEASE_MAX_TTL_MS: String(24 * 60 * 60_000),
        AGENT_DEVICE_STATE_DIR: phonesStateDir,
        ANDROID_ADB_SERVER_PORT: "5037",
        HOME: "/home/operator",
        PATH: "/usr/local/bin:/usr/bin",
        ...signingKeys,
      });
      await expect(harness.filesystem.readFile(`${phonesStateDir}/policy.json`)).resolves.toContain(
        "device-shutdown",
      );
      expect(
        JSON.parse(await harness.filesystem.readFile(`${home}/agent-device-phones-daemon.json`)),
      ).toMatchObject({
        entry: internalEntry,
      });
      expect(await harness.filesystem.exists(`${stateDir}/policy.json`)).toBe(false);
      expect(await harness.filesystem.exists(recordPath)).toBe(false);
    },
  );
});

describe("AgentDeviceSupervisor reaping by role", () => {
  const phonesRecordPath = `${home}/agent-device-phones-daemon.json`;
  const leftBehind = (path: string, pid: number) => async (filesystem: MemoryFilesystem) => {
    await filesystem.writeFileAtomic(path, JSON.stringify(record(pid)));
  };

  it.each([
    {
      name: "a phones record whose pid line ends with the phones suffix is signalled, with the simulator record left alone",
      role: "phones",
      line: ownLine(internalEntry, home, "phones"),
      otherRecord: recordPath,
      signalled: true,
      survivingRecord: recordPath,
    },
    {
      name: "a simulators record whose pid line ends with the simulators suffix is signalled, with the phones record left alone",
      role: "simulators",
      line: ownLine(),
      otherRecord: phonesRecordPath,
      signalled: true,
      survivingRecord: phonesRecordPath,
    },
    {
      name: "a phones record whose pid line is a simulator daemon's is not signalled",
      role: "phones",
      line: ownLine(),
      otherRecord: undefined,
      signalled: false,
      survivingRecord: undefined,
    },
    {
      name: "a simulators record whose pid line is a phone daemon's is not signalled",
      role: "simulators",
      line: ownLine(internalEntry, home, "phones"),
      otherRecord: undefined,
      signalled: false,
      survivingRecord: undefined,
    },
  ] as const)(
    "signals only a pid whose line ends with its own role's suffix, and never touches the other role's record: $name",
    async ({ line, otherRecord, role, signalled, survivingRecord }) => {
      const harness = await run({
        commandLines: [[900, [line]]],
        expectations: [versionRun(), role === "phones" ? phoneSpawn() : daemonSpawn()],
        layout: async (filesystem) => {
          if (otherRecord !== undefined) await leftBehind(otherRecord, 901)(filesystem);
        },
        livePids: [900, 901],
        record: record(900),
        role,
      });

      expect(harness.processes.signals).toEqual(signalled ? [{ pid: 900, signal: "SIGTERM" }] : []);
      expect(stateOf(harness)).toBe("running");
      if (survivingRecord !== undefined) {
        expect(await readJson(harness, survivingRecord)).toMatchObject({ pid: 901 });
      }
    },
  );
});

describe("AgentDeviceSupervisor stopping and restarting the phone daemon", () => {
  const phonesRecordPath = `${home}/agent-device-phones-daemon.json`;
  const phones = {
    expectations: [versionRun(), phoneSpawn(), versionRun(), phoneSpawn()],
    role: "phones",
  } as const;

  it("stop signals the phone daemon and removes its record", async () => {
    const harness = await run(phones);
    const pid = harness.children[0]?.pid;

    await advancing(harness, harness.agentDevice.stop());

    expect(harness.processes.signals).toEqual([{ pid, signal: "SIGTERM" }]);
    await expect(harness.filesystem.exists(phonesRecordPath)).resolves.toBe(false);
    expect(stateOf(harness)).toBe("off");
  });

  it.each([
    { afterMs: 60_000, restartsAtOnce: true },
    { afterMs: 5_000, restartsAtOnce: false },
  ])(
    "a phone daemon that exits $afterMs ms after it was ready restarts at once only when that is 60 s or more, else after 30 s with a warning that names its role",
    async ({ afterMs, restartsAtOnce }) => {
      const harness = await run(phones);
      await advanceBy(harness, afterMs);

      harness.children[0]?.exit(9);
      await flush();

      if (restartsAtOnce) {
        expect(stateOf(harness)).toBe("starting");
      } else {
        expect(unavailable(harness)).toMatchObject({ reason: "start-failed" });
        expect(
          warnings(harness).some((line) => line.includes("agent-device (phones) start failed")),
        ).toBe(true);
        await advanceBy(harness, 29_000);
        expect(daemonSpawns(harness)).toHaveLength(1);
      }
      await advanceUntil(harness, () => stateOf(harness) === "running", 5_000);
      expect(daemonSpawns(harness)).toHaveLength(2);
    },
  );
});
