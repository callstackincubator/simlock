import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import type { StatusGetOutput } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import { EMPTY_STATUS, PACKAGE_VERSION, fakeClient, outputCapture } from "./test-index.js";

describe("CLI: status renders the fleet a gateway reports (ADR 0005 §20)", () => {
  describe("against a starting daemon", () => {
    const STARTING: StatusGetOutput = {
      daemon: {
        health: "starting",
        mode: "worker",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
    };

    it("simlock status prints the starting line and no device, lease or capacity line", async () => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(STARTING) }),
        }),
      );

      expect(output.stdout).toBe(
        "Daemon: starting (worker)\n" +
          "Simlock: 0.0.0-test\n" +
          `CLI: ${PACKAGE_VERSION}\n` +
          "Host: macOS 15.5 arm64\n" +
          "Devices, leases and capacity appear once startup finishes.\n",
      );
    });

    it.each(["capacity", "devices", "leases", "queueDepth"] as const)(
      "simlock status prints the starting line for an answer with no %s, though the rest is there",
      async (missing) => {
        const output = outputCapture();
        const { [missing]: _left, ...answer } = EMPTY_STATUS;
        await runCli(
          ["status"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(answer as StatusGetOutput) }),
          }),
        );

        expect(output.stdout).toContain(
          "Devices, leases and capacity appear once startup finishes.\n",
        );
        expect(output.stdout).not.toContain("Queue depth");
      },
    );

    it("simlock status --json prints the answer with those fields absent", async () => {
      const output = outputCapture();
      await runCli(
        ["status", "--json"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(STARTING) }),
        }),
      );

      expect(JSON.parse(output.stdout)).toEqual({ ...STARTING, cliVersion: PACKAGE_VERSION });
    });
  });

  it("prints the host line", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getStatus: () =>
            Promise.resolve({
              ...EMPTY_STATUS,
              host: {
                arch: "arm64",
                os: "macOS",
                osVersion: "15.5",
                tools: [
                  { build: "16F6", name: "xcode", platform: "ios" as const, version: "16.4" },
                ],
              },
            }),
        }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Host: macOS 15.5 arm64; xcode 16.4 (16F6)\n");
  });

  describe("the Load line", () => {
    const GIB = 2 ** 30;
    const MIB = 2 ** 20;
    const LOAD = {
      ageMs: 4_000,
      cpu: { busyPercent: 34.2, cores: 10, limited: false },
      disk: { freeBytes: 120_688_581_018, totalBytes: 530_857_957_786 },
      memory: {
        availableBytes: 10_522_669_875,
        limited: false,
        pressure: "normal" as const,
        swapUsedBytes: 1_288_490_189,
        totalBytes: 32 * GIB,
      },
    };
    const FULL_LINE =
      "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago\n";
    const STARTING = {
      daemon: {
        health: "starting" as const,
        mode: "worker" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "arm64", os: "macOS", osVersion: "15.5", tools: [] },
    };

    const print = async (status: StatusGetOutput): Promise<string> => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const loadLine = async (load: StatusGetOutput["load"]): Promise<string> => {
      const stdout = await print({ ...EMPTY_STATUS, load });
      return stdout.split("\n").find((line) => line.startsWith("Load:")) ?? "";
    };

    it("simlock status prints the Load line after the Host line, on a starting daemon and a running one", async () => {
      expect(await print({ ...STARTING, load: LOAD })).toBe(
        "Daemon: starting (worker)\n" +
          "Simlock: 0.0.0-test\n" +
          `CLI: ${PACKAGE_VERSION}\n` +
          "Host: macOS 15.5 arm64\n" +
          FULL_LINE +
          "Devices, leases and capacity appear once startup finishes.\n",
      );

      expect(await print({ ...EMPTY_STATUS, load: LOAD })).toContain(
        `Host: macOS 15.5 arm64\n${FULL_LINE}`,
      );
    });

    it("simlock status prints CPU unavailable, memory unavailable or disk unavailable for an absent part, and no swap or pressure part when memory is absent", async () => {
      const { cpu: _cpu, ...withoutCpu } = LOAD;
      const { memory: _memory, ...withoutMemory } = LOAD;
      const { disk: _disk, ...withoutDisk } = LOAD;

      expect(await loadLine(withoutCpu)).toBe(
        "Load: CPU unavailable · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(await loadLine(withoutMemory)).toBe(
        "Load: CPU 34% busy (10 cores) · memory unavailable · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(await loadLine(withoutDisk)).toBe(
        "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk unavailable · read 4s ago",
      );
    });

    it("simlock status prints no pressure part when the reading has none, and limit on a limited CPU or memory", async () => {
      const { pressure: _pressure, ...noPressure } = LOAD.memory;

      expect(await loadLine({ ...LOAD, memory: noPressure })).toBe(
        "Load: CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
      expect(
        await loadLine({
          ...LOAD,
          cpu: { busyPercent: 34.2, cores: 2, limited: true },
          memory: { ...LOAD.memory, availableBytes: 3 * GIB, limited: true, totalBytes: 8 * GIB },
        }),
      ).toBe(
        "Load: CPU 34% busy (2 cores, limit) · memory 3.0 GiB of 8.0 GiB available (limit) · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free · read 4s ago",
      );
    });

    it.each([
      ["swap 0 B", { memory: { ...LOAD.memory, swapUsedBytes: 0 } }, "swap 0 B used"],
      [
        "swap 300 MiB",
        { memory: { ...LOAD.memory, swapUsedBytes: 300 * MIB } },
        "swap 300 MiB used",
      ],
      [
        "swap 1023.6 MiB",
        { memory: { ...LOAD.memory, swapUsedBytes: 1_073_322_394 } },
        "swap 1.0 GiB used",
      ],
      ["busy 34.5", { cpu: { ...LOAD.cpu, busyPercent: 34.5 } }, "CPU 35% busy"],
      ["cores 1", { cpu: { ...LOAD.cpu, cores: 1 } }, "(1 core)"],
      ["cores 0.5", { cpu: { ...LOAD.cpu, cores: 0.5 } }, "(0.5 cores)"],
      ["cores 10", { cpu: { ...LOAD.cpu, cores: 10 } }, "(10 cores)"],
      ["cores 0.01", { cpu: { ...LOAD.cpu, cores: 0.01 } }, "(0.01 cores)"],
      ["cores 0.001", { cpu: { ...LOAD.cpu, cores: 0.001 } }, "(<0.01 cores)"],
      ["ageMs 4001", { ageMs: 4_001 }, "read 5s ago"],
      ["ageMs 0", { ageMs: 0 }, "read 0s ago"],
    ])("simlock status formats %s as in the inputs table", async (_row, change, fragment) => {
      expect(await loadLine(LOAD)).toContain("CPU 34% busy (10 cores)");

      expect(await loadLine({ ...LOAD, ...change })).toContain(fragment);
    });

    it("simlock status prints no Load line when the answer has no load block", async () => {
      expect(await print({ ...EMPTY_STATUS, load: LOAD })).toContain("Load: ");

      expect(await print(EMPTY_STATUS)).not.toContain("Load:");
      expect(await print(STARTING)).not.toContain("Load:");
    });

    it("simlock status prints the Memory pressure line with the step, when it began and why, and none when there is no step", async () => {
      const line = async (memoryPressure: unknown) =>
        (
          await print({
            ...EMPTY_STATUS,
            capacity: { ...EMPTY_STATUS.capacity, memoryPressure },
            load: LOAD,
          } as StatusGetOutput)
        )
          .split("\n")
          .find((row) => row.startsWith("Memory pressure:"));
      const since = new Date(2026, 10, 6, 9, 12).getTime();
      const warn = { availablePercent: 34, level: "warn", trigger: "level" };
      const floor = (availablePercent: number, extra = {}) =>
        line({
          cause: { availablePercent, floorPercent: 10, trigger: "floor", ...extra },
          since,
          step: "new-devices-paused",
        });

      expect(await line({ cause: warn, since, step: "warming-paused" })).toBe(
        "Memory pressure: warming paused since 09:12 (pressure warn)",
      );
      const floored = "Memory pressure: new devices paused since 09:12 (8% available, floor 10%)";
      expect(await floor(8)).toBe(floored);
      expect(await floor(8, { level: "warn" })).toBe(floored);
      expect(await floor(9)).toBe(floored.replace("8%", "9%"));
      expect(await line({ step: "none" })).toBeUndefined();
      expect(await line(undefined)).toBeUndefined();

      const stdout = await print({
        ...EMPTY_STATUS,
        capacity: {
          ...EMPTY_STATUS.capacity,
          memoryPressure: { cause: warn, since, step: "warming-paused" },
        },
        load: LOAD,
      } as StatusGetOutput);
      expect(stdout).toContain(
        `${FULL_LINE}Memory pressure: warming paused since 09:12 (pressure warn)\nRunning global`,
      );
    });
  });

  it("simlock status prints the console address when HTTP is enabled", async () => {
    const print = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const daemon = { ...EMPTY_STATUS.daemon, consoleUrl: "http://127.0.0.1:4700/" };

    expect(await print({ ...EMPTY_STATUS, daemon })).toContain(
      `Daemon: running (worker)\nSimlock: 0.0.0-test\nCLI: ${PACKAGE_VERSION}\nConsole: http://127.0.0.1:4700/\nHost: `,
    );
    expect(await print(EMPTY_STATUS)).not.toContain("Console:");
  });

  it("simlock daemon start prints the console address when HTTP is enabled", async () => {
    const start = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["daemon", "start"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const daemon = { ...EMPTY_STATUS.daemon, consoleUrl: "http://127.0.0.1:4700/" };

    expect(await start({ ...EMPTY_STATUS, daemon })).toBe(
      "Daemon running\nConsole: http://127.0.0.1:4700/\n",
    );
    expect(await start(EMPTY_STATUS)).toBe("Daemon running\n");
  });

  describe("the history lines of simlock status", () => {
    const NOT_WRITTEN = "History: the event history is not being written; see daemon.log.";
    const SET_ASIDE_AT = Date.UTC(2026, 9, 16, 9, 12, 30);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const local = new Date(SET_ASIDE_AT);
    const setAside = `History: the event history was damaged and set aside at ${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}; a fresh one was started.`;

    const statusLines = async (history: StatusGetOutput["history"]): Promise<string[]> => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              getStatus: () =>
                Promise.resolve({
                  ...EMPTY_STATUS,
                  ...(history === undefined ? {} : { history }),
                } as StatusGetOutput),
            }),
        }),
      );
      return output.stdout.trimEnd().split("\n");
    };

    it("prints the not-written line when writing is false, the set-aside line with the local time when setAsideAt is set, both when both hold, and neither otherwise", async () => {
      const healthy = await statusLines({ opened: true, writing: true });
      const notWritten = await statusLines({ opened: false, writing: false });
      const aside = await statusLines({ opened: true, setAsideAt: SET_ASIDE_AT, writing: true });
      const both = await statusLines({ opened: true, setAsideAt: SET_ASIDE_AT, writing: false });

      expect(healthy.filter((line) => line.startsWith("History:"))).toEqual([]);
      expect(notWritten.filter((line) => line.startsWith("History:"))).toEqual([NOT_WRITTEN]);
      expect(aside.filter((line) => line.startsWith("History:"))).toEqual([setAside]);
      expect(both.filter((line) => line.startsWith("History:")).sort()).toEqual(
        [NOT_WRITTEN, setAside].sort(),
      );
    });

    it("prints the rebuilt line with the local time when rebuiltAt is set and the could-not-rebuild line when rebuildFailed is set, and neither otherwise", async () => {
      const rebuiltLine = `History: figures were rebuilt from the event history at ${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}.`;
      const failedLine = "History: figures could not be rebuilt; see daemon.log.";
      const plain = await statusLines({ opened: true, writing: true });
      const rebuilt = await statusLines({ opened: true, rebuiltAt: SET_ASIDE_AT, writing: true });
      const failed = await statusLines({ opened: true, rebuildFailed: true, writing: true });

      expect(plain.filter((line) => line.startsWith("History:"))).toEqual([]);
      expect(rebuilt.filter((line) => line.startsWith("History:"))).toEqual([rebuiltLine]);
      expect(failed.filter((line) => line.startsWith("History:"))).toEqual([failedLine]);
    });
  });

  it("prints an install line while one runs and none after", async () => {
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 1_000,
      state: "downloading" as const,
      waiters: 1,
    };
    const print = async (installs: StatusGetOutput["installs"]) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          clock: new FakeClock(43_000),
          connectAdmin: async () =>
            fakeClient({ getStatus: () => Promise.resolve({ ...EMPTY_STATUS, installs }) }),
        }),
      );
      return output.stdout;
    };

    expect(await print([install])).toContain("Install ios 26.4: downloading for 42s, 1 waiter\n");
    expect(await print([])).not.toContain("Install ");
  });

  it("prints an install whose start is ahead of this machine's clock as 0s old, not a negative age", async () => {
    const output = outputCapture();
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 5_000,
      state: "waiting" as const,
      waiters: 1,
    };
    await runCli(
      ["status"],
      output.environmentWith({
        clock: new FakeClock(1_000),
        connectAdmin: async () =>
          fakeClient({
            getStatus: () => Promise.resolve({ ...EMPTY_STATUS, installs: [install] }),
          }),
      }),
    );

    expect(output.stdout).toContain("Install ios 26.4: waiting for 0s, 1 waiter\n");
  });

  it("prints a gateway's installs once each, naming the worker, not again under the worker", async () => {
    const output = outputCapture();
    const install = {
      component: "35",
      platform: "android" as const,
      since: 0,
      state: "waiting" as const,
      waiters: 3,
    };
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      daemon: {
        health: "running",
        mode: "gateway",
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      installs: [{ ...install, workerId: "wrk_1" }],
      workers: [
        {
          catalog: [],
          connection: "connected",
          devices: [],
          drained: false,
          id: "wrk_1",
          installs: [install],
          lastSeenAt: 1,
          leases: [],
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout.match(/Install /g)).toHaveLength(1);
    expect(output.stdout).toContain("Install android 35 on wrk_1: waiting for 0s, 3 waiters\n");
  });

  it("prints each device's mode and whether it serves a request naming no mode", async () => {
    const output = outputCapture();
    const spec = {
      physical: false,
      model: "iPhone 17",
      osVersion: "26.0",
      platform: "ios" as const,
    };
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        {
          physical: false,
          id: "dev_slim",
          mode: "slim",
          servesDefaultMode: false,
          spec,
          state: "ready",
        },
        {
          physical: false,
          id: "dev_full",
          mode: "full",
          servesDefaultMode: true,
          spec,
          state: "leased",
        },
        {
          physical: false,
          id: "dev_copy",
          mode: "full",
          servesDefaultMode: true,
          spec: { ...spec, baseline: { name: "checkout", version: 2 } },
          state: "leased",
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Device dev_slim: ready, mode slim, serves default mode: no\n");
    expect(output.stdout).toContain(
      "Device dev_full: leased, mode full, serves default mode: yes\n",
    );
    expect(output.stdout).toContain(
      "Device dev_copy: leased, mode full, serves default mode: yes, baseline checkout v2\n",
    );
  });

  it("prints the RAM budget, marked over limit when over, and no RAM line when the daemon reports none", async () => {
    type RamBudget = NonNullable<NonNullable<StatusGetOutput["capacity"]>["ramBudget"]>;
    const statusWith = (ramBudget?: RamBudget) => {
      const status: StatusGetOutput = {
        ...EMPTY_STATUS,
        capacity: { ...EMPTY_STATUS.capacity, ...(ramBudget === undefined ? {} : { ramBudget }) },
      };
      return status;
    };
    const print = async (status: StatusGetOutput) => {
      const output = outputCapture();
      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );
      return output.stdout;
    };
    const gib = 1024 ** 3;

    expect(
      await print(statusWith({ limitBytes: 12 * gib, overLimit: false, usedBytes: 4.5 * gib })),
    ).toContain("RAM budget: 4.50 GiB/12.00 GiB used\n");
    expect(
      await print(statusWith({ limitBytes: 12 * gib, overLimit: true, usedBytes: 13 * gib })),
    ).toContain("RAM budget: 13.00 GiB/12.00 GiB used (over limit)\n");
    expect(await print(statusWith())).not.toContain("RAM");
  });

  it("prints, per platform, whether the worker is at its RAM budget, after any over-limit mark", async () => {
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      capacity: {
        ...EMPTY_STATUS.capacity,
        android: { ...EMPTY_STATUS.capacity.android, atRamBudget: false },
        ios: { ...EMPTY_STATUS.capacity.ios, atRamBudget: true, overLimit: true },
      },
    };
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain(
      "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0 (over limit) (at RAM budget)",
    );
    expect(lines).toContain("Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0");
  });

  it("simlock status prints a physical device as physical and its class, with today's markers, and a simulator's line as before", async () => {
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        {
          class: "phone",
          id: "dev_p1",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "ready",
        },
        {
          class: "tablet",
          id: "dev_p2",
          physical: true,
          servesDefaultMode: false,
          spec: { model: "iPad Pro", osVersion: "18.4", physical: true, platform: "ios" },
          state: "quarantined",
          quarantineAttempts: 1,
          workerId: "wrk_1",
        },
        {
          id: "dev_v1",
          mode: "full",
          physical: false,
          servesDefaultMode: true,
          spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
          state: "ready",
        },
      ],
    };
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_p1: ready, physical phone");
    expect(lines).toContain("Device dev_p2 on wrk_1: quarantined, physical tablet (purge retry 1)");
    expect(lines).toContain("Device dev_v1: ready, mode full, serves default mode: yes");
  });

  it("status ends a quarantined device's marker with ; and the cause for each kind, and prints today's marker when there is no cause", async () => {
    const quarantined = (
      id: string,
      quarantineCause?: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id,
      mode: "full",
      physical: false,
      quarantineAttempts: 1,
      quarantineNextRetryAt: 1_760_619_150_000,
      servesDefaultMode: true,
      spec: { model: "iPhone 16", osVersion: "18.4", physical: false, platform: "ios" },
      state: "quarantined",
      ...(quarantineCause === undefined ? {} : { quarantineCause }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [
        quarantined("dev_purge", {
          kind: "purge-failed",
          message: "DriverCrashError: simctl erase exited 164, then stalled",
        }),
        quarantined("dev_shutdown", {
          kind: "shutdown-failed",
          message: "Error: shutdown exploded",
        }),
        quarantined("dev_delete", { kind: "delete-failed", message: "Error: delete exploded" }),
        quarantined("dev_prov", { kind: "stalled", stalledState: "provisioning" }),
        quarantined("dev_recl", { kind: "stalled", stalledState: "reclaiming" }),
        quarantined("dev_none"),
      ],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    const head =
      "quarantined, mode full, serves default mode: yes (purge retry 1, next retry at 1760619150000";
    expect(lines).toContain(
      `Device dev_purge: ${head}; purge failed: DriverCrashError: simctl erase exited 164, then stalled)`,
    );
    expect(lines).toContain(
      `Device dev_shutdown: ${head}; shutdown failed: Error: shutdown exploded)`,
    );
    expect(lines).toContain(`Device dev_delete: ${head}; delete failed: Error: delete exploded)`);
    expect(lines).toContain(`Device dev_prov: ${head}; stalled while provisioning)`);
    expect(lines).toContain(`Device dev_recl: ${head}; stalled while reclaiming)`);
    expect(lines).toContain(`Device dev_none: ${head})`);
  });

  it("status prints absent (<reason>) as the state of an absent device", async () => {
    const physical = (id: string, state: string, absentReason?: string) => ({
      class: "phone",
      id,
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state,
      ...(absentReason === undefined ? {} : { absentReason }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [
        physical("dev_ready", "ready"),
        physical("dev_locked", "absent", "locked"),
        physical("dev_untrusted", "absent", "untrusted"),
        physical("dev_gone", "absent", "not-present"),
      ],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_ready: ready, physical phone");
    expect(lines).toContain("Device dev_locked: absent (locked), physical phone");
    expect(lines).toContain("Device dev_untrusted: absent (untrusted), physical phone");
    expect(lines).toContain("Device dev_gone: absent (not-present), physical phone");
  });

  it("status prints a bare state for an absent device with no reason and for a device that is not absent", async () => {
    const physical = (id: string, state: string, absentReason?: string) => ({
      class: "phone",
      id,
      physical: true,
      servesDefaultMode: false,
      spec: { model: "iPhone 15 Pro", osVersion: "18.4", physical: true, platform: "ios" },
      state,
      ...(absentReason === undefined ? {} : { absentReason }),
    });
    const status = {
      ...EMPTY_STATUS,
      devices: [physical("dev_bare", "absent"), physical("dev_stray", "ready", "locked")],
    } as unknown as StatusGetOutput;
    const output = outputCapture();

    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    const lines = output.stdout.split("\n");
    expect(lines).toContain("Device dev_bare: absent, physical phone");
    expect(lines).toContain("Device dev_stray: ready, physical phone");
  });

  it("simlock status marks a stalled device", async () => {
    const device = (id: string, extra: object) => ({
      physical: false,
      id,
      mode: "full" as const,
      servesDefaultMode: true,
      spec: { physical: false, model: "iPhone 16", osVersion: "18.4", platform: "ios" as const },
      state: "provisioning" as const,
      ...extra,
    });
    const status: StatusGetOutput = {
      ...EMPTY_STATUS,
      devices: [
        device("dev_stuck", { stalled: true, transitionAgeMs: 120_000 }),
        device("dev_fresh", { transitionAgeMs: 2_000 }),
      ],
    };
    const output = outputCapture();
    await runCli(
      ["status"],
      output.environmentWith({
        connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
      }),
    );

    expect(output.stdout).toContain(
      "Device dev_stuck: provisioning, mode full, serves default mode: yes (mid-transition 120000ms, stalled)\n",
    );
    expect(output.stdout).toContain(
      "Device dev_fresh: provisioning, mode full, serves default mode: yes (mid-transition 2000ms)\n",
    );
  });
});
