import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import type { SimlockAdminClient, StatusGetOutput } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import {
  EMPTY_STATUS,
  PACKAGE_VERSION,
  fakeClient,
  outputCapture,
  usageAnswer,
} from "./test-index.js";

describe("CLI: status renders the fleet a gateway reports (ADR 0005 §20)", () => {
  it("names the mode, each worker, and which worker a device and a lease live on", async () => {
    const output = outputCapture();
    const status = {
      capacity: {
        android: {
          atRamBudget: false,
          limit: 0,
          maxRunning: 0,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 0,
          warm: 0,
        },
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 1, warm: 0 },
        ios: {
          atRamBudget: false,
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 1,
          used: 1,
          warm: 0,
        },
      },
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      host: { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] },
      devices: [
        {
          physical: false,
          id: "dev_1",
          spec: {
            physical: false,
            model: "iPhone 17",
            osVersion: "26.0",
            platform: "ios" as const,
          },
          mode: "full" as const,
          servesDefaultMode: true,
          state: "leased" as const,
          workerId: "wrk_1",
        },
      ],
      leases: [
        {
          deviceId: "dev_1",
          grantedAt: 1,
          id: "lease_1",
          lastRenewedAt: 1,
          idChosenByRequester: false,
          ownerId: "agent-1",
          requesterId: "agent-1",
          ttlDeadline: 2,
          ttlMs: 1,
          workerId: "wrk_1",
        },
      ],
      queueDepth: 0,
      workers: [
        {
          capacity: undefined,
          catalog: [],
          connection: "connected" as const,
          devices: [],
          drained: true,
          id: "wrk_1",
          lastSeenAt: 1,
          leases: [],
        },
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toContain("Daemon: running (gateway)");
    // why: A gateway runs no drivers: its host line names the machine and nothing after it.
    expect(output.stdout).toContain("Host: Linux 6.8.0 x64\n");
    expect(output.stdout).toContain("wrk_1: connected, drained");
    expect(output.stdout).toContain(
      "Device dev_1 on wrk_1: leased, mode full, serves default mode: yes",
    );
    expect(output.stdout).toContain("Lease lease_1: agent-1 on wrk_1");
  });

  describe("the warm pool block", () => {
    const warmPool = {
      enabled: true,
      reserveRunning: { android: 0, ios: 1 },
      targets: [
        {
          booting: 1,
          count: 2,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "configured" as const,
          osVersion: "26.0",
          platform: "ios" as const,
          ready: 1,
        },
        {
          booting: 0,
          count: 1,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "learned" as const,
          osVersion: "27.0",
          platform: "ios" as const,
          ready: 0,
          short: "runtime-missing" as const,
        },
        {
          booting: 0,
          count: 1,
          imageTag: "google_apis_playstore",
          mode: "full" as const,
          model: "Pixel 8",
          origin: "learned" as const,
          osVersion: "35",
          platform: "android" as const,
          ready: 1,
        },
        {
          baseline: "checkout",
          booting: 0,
          count: 1,
          mode: "full" as const,
          model: "iPhone 17",
          origin: "learned" as const,
          osVersion: "26.0",
          platform: "ios" as const,
          ready: 1,
        },
      ],
    };
    const statusWith = (block: StatusGetOutput["warmPool"]) =>
      fakeClient({ getStatus: () => Promise.resolve({ ...EMPTY_STATUS, warmPool: block }) });

    it("simlock status prints the origin word on every warm pool line, learned lines included, the tag in the name, and a learned line's short:", async () => {
      const output = outputCapture();

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(warmPool) }),
      );

      expect(output.stdout).toContain(
        "warm pool: enabled, reserve ios 1 android 0\n" +
          "  iPhone 17 / 26.0 / full   configured   wanted 2  ready 1  booting 1\n" +
          "  iPhone 17 / 27.0 / full   learned   wanted 1  ready 0  booting 0  short: runtime-missing\n" +
          "  Pixel 8 / 35 / full / google_apis_playstore   learned   wanted 1  ready 1  booting 0\n" +
          "  iPhone 17 / 26.0 / full / baseline checkout   learned   wanted 1  ready 1  booting 0\n",
      );
    });

    it("simlock status leaves the runtime out of a target that names none", async () => {
      const output = outputCapture();
      const unversioned = {
        enabled: true,
        reserveRunning: { android: 0, ios: 0 },
        targets: [
          {
            booting: 0,
            count: 1,
            mode: "slim" as const,
            model: "iPhone 17",
            origin: "configured" as const,
            platform: "ios" as const,
            ready: 0,
          },
        ],
      };

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(unversioned) }),
      );

      expect(output.stdout).toContain(
        "warm pool: enabled, reserve ios 0 android 0\n" +
          "  iPhone 17 / slim   configured   wanted 1  ready 0  booting 0\n",
      );
    });

    it("simlock status prints a pool that is off as disabled, with every target short disabled", async () => {
      const output = outputCapture();
      const off = {
        enabled: false,
        reserveRunning: { android: 0, ios: 0 },
        targets: warmPool.targets.slice(0, 1).map((target) => ({
          ...target,
          booting: 0,
          ready: 0,
          short: "disabled" as const,
        })),
      };

      await runCli(
        ["status"],
        output.environmentWith({ connectAdmin: async () => statusWith(off) }),
      );

      expect(output.stdout).toContain(
        "warm pool: disabled, reserve ios 0 android 0\n" +
          "  iPhone 17 / 26.0 / full   configured   wanted 2  ready 0  booting 0  short: disabled\n",
      );
    });

    it.each([
      {
        name: "worker whose answer has no block",
        mode: "worker" as const,
        warmPool: undefined,
      },
      {
        name: "gateway whose own block is empty",
        mode: "gateway" as const,
        warmPool: { enabled: false, reserveRunning: { android: 0, ios: 0 }, targets: [] },
      },
    ])("simlock status prints no warm pool line for a $name", async ({ mode, warmPool }) => {
      const output = outputCapture();

      await runCli(
        ["status"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              getStatus: () =>
                Promise.resolve({
                  ...EMPTY_STATUS,
                  daemon: {
                    health: "running" as const,
                    mode,
                    version: "0.0.0-test",
                    update: null,
                    lastUpdateFailure: null,
                    latestVersion: null,
                  },
                  warmPool,
                }),
            }),
        }),
      );

      expect(output.stdout).toBe(
        `Daemon: running (${mode})\n` +
          "Simlock: 0.0.0-test\n" +
          `CLI: ${PACKAGE_VERSION}\n` +
          "Host: macOS 15.5 arm64\n" +
          "Running global: 0 + 0 reserved/2, warm 0\n" +
          "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
          "Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
          "Queue depth: 0\n",
      );
    });

    it.each(["worker", "gateway"] as const)(
      "simlock status of a %s with queueDepth 2 and physicalQueueDepth 1 prints Queue depth: 2",
      async (mode) => {
        const output = outputCapture();
        const answer = {
          ...EMPTY_STATUS,
          daemon: { ...EMPTY_STATUS.daemon, mode },
          physicalQueueDepth: 1,
          queueDepth: 2,
        } as unknown as StatusGetOutput;

        await runCli(
          ["status"],
          output.environmentWith({
            connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(answer) }),
          }),
        );

        expect(output.stdout).toBe(
          `Daemon: running (${mode})\n` +
            "Simlock: 0.0.0-test\n" +
            `CLI: ${PACKAGE_VERSION}\n` +
            "Host: macOS 15.5 arm64\n" +
            "Running global: 0 + 0 reserved/2, warm 0\n" +
            "Capacity ios: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
            "Capacity android: managed 0/1, running 0 + 0 reserved/1, warm 0\n" +
            "Queue depth: 2\n",
        );
      },
    );

    it("simlock status --json carries the block as the daemon sent it", async () => {
      const output = outputCapture();

      await runCli(
        ["status", "--json"],
        output.environmentWith({ connectAdmin: async () => statusWith(warmPool) }),
      );

      expect(JSON.parse(output.stdout).warmPool).toEqual(warmPool);
      expect(JSON.parse(output.stdout).cliVersion).toBe(PACKAGE_VERSION);
    });

    it("simlock doctor prints one stderr line per unreachable warm pool target, keeps the JSON report on stdout, and exits 0", async () => {
      const output = outputCapture();
      const findings = [
        {
          kind: "warm-pool-target-unreachable" as const,
          message: "iOS 27.0 is not installed",
          platform: "ios" as const,
          reason: "runtime-missing" as const,
          remedy: "run simlock component install ios 27.0",
          target: "iPhone 17 / 27.0 / full",
        },
        {
          kind: "warm-pool-target-unreachable" as const,
          message: "the targets want 4 running devices, and the running limit leaves room for 3",
          reason: "over-limit" as const,
          remedy: "lower the counts of the warmPool.targets, or raise the running limit",
          target: "all targets",
        },
        { deviceId: "d-1", kind: "expired-live-lease" as const, leaseId: "l-1" },
      ];

      await expect(
        runCli(
          ["doctor"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] }) }),
          }),
        ),
      ).resolves.toBe(0);

      expect(
        output.stderr
          .split("\n")
          .filter((line) => line.includes("warm-pool-target-unreachable") || line.includes("d-1")),
      ).toEqual([
        "warm-pool-target-unreachable  iPhone 17 / 27.0 / full: iOS 27.0 is not installed; run simlock component install ios 27.0",
        "warm-pool-target-unreachable  all targets: the targets want 4 running devices, and the running limit leaves room for 3; lower the counts of the warmPool.targets, or raise the running limit",
      ]);
      expect(output.stderr).not.toContain("undefined");
      expect(JSON.parse(output.stdout)).toEqual({ findings, sources: [] });
    });
  });
});

describe("CLI text output escapes control characters in remote text", () => {
  const NOW = Date.parse("2026-10-05T12:00:00.000Z");
  type View = Awaited<ReturnType<SimlockAdminClient["listWorkers"]>>["workers"][number];
  const worker = (overrides: Partial<View> = {}): View => ({
    connection: "connected",
    drained: false,
    id: "3f81a2c4",
    lastSeenAt: 1_000,
    version: "0.3.0",
    ...overrides,
  });
  const failure = (message: string) =>
    ({ at: 2_000, from: "0.3.0", message, stage: "installing", to: "0.4.0" }) as const;

  it.each([
    ["ESC", "\u001b", "\\u001b"],
    ["BEL", "\u0007", "\\u0007"],
    ["CR", "\r", "\\u000d"],
    ["NUL", "\u0000", "\\u0000"],
    ["C1 CSI", "\u009b", "\\u009b"],
  ])(
    "simlock stats, worker list, worker update, device add, update, warm forget and daemon logs print %s in remote text escaped",
    async (_name, raw, escaped) => {
      const text = `a${raw}b`;
      const shown = `a${escaped}b`;
      const run = async (argv: readonly string[], client: Partial<SimlockAdminClient>) => {
        const output = outputCapture();
        const code = await runCli(
          [...argv],
          output.environmentWith({
            readLogFile: async () => `ok\n${text}\n`,
            clock: new FakeClock(NOW),
            connectAdmin: async () => fakeClient(client),
            sleep: async () => undefined,
          }),
        );
        return { code, stdout: output.stdout };
      };
      const updateAnswer = (version: string) =>
        ({
          health: "running",
          lastUpdateFailure: null,
          latestVersion: "0.4.0",
          resolved: "0.4.0",
          started: true,
          update: {
            forced: false,
            from: version,
            stage: "installing",
            startedAt: 1_000,
            to: "0.4.0",
          },
          upToDate: false,
          version,
          workerId: "3f81a2c4",
        }) as Awaited<ReturnType<SimlockAdminClient["updateWorker"]>>;

      const stats = await run(["stats"], {
        usage: async (window) =>
          usageAnswer(window, {
            requesters: [{ id: text, granted: 0, heldTotalMs: 0, rejected: 0, requests: 1 }],
          }),
      });
      const list = await run(["worker", "list"], {
        listWorkers: async () => ({ workers: [worker({ version: text })] }),
      });
      const detached = await run(["worker", "update", "3f81a2c4", "--detach"], {
        listWorkers: async () => ({ workers: [worker()] }),
        updateWorker: async () => updateAnswer(text),
      });
      const failed = await run(["worker", "update", "3f81a2c4"], {
        listWorkers: async () => ({
          workers: [worker({ lastUpdateFailure: failure(text), update: null })],
        }),
        updateWorker: async () => updateAnswer("0.3.0"),
      });
      const enrolled = await run(["device", "add", "--platform", "android", "SER-1"], {
        addDevice: async () => ({
          appCount: 0,
          class: "phone",
          driverDeviceId: "SER-1",
          id: "dev_1",
          model: text,
          osVersion: text,
          platform: "android",
          reenrolled: false,
        }),
      });

      let polled = 0;
      const daemonFollowed = await run(["update"], {
        updateDaemon: async () => {
          polled += 1;
          const answer = updateAnswer(text);
          return polled === 1 ? answer : { ...answer, update: null };
        },
      });
      const daemonFailed = await run(["update"], {
        updateDaemon: async () => ({
          ...updateAnswer("0.3.0"),
          update: null,
          lastUpdateFailure: failure(text),
        }),
      });
      const forgotten = await run(["warm", "forget", "android", "Pixel"], {
        forgetWarmKind: async () => ({
          forgotten: [{ platform: "android", model: text, osVersion: "36", mode: "full" }],
        }),
      });
      const logs = await run(["daemon", "logs"], {});
      const results = {
        logs,
        stats,
        list,
        detached,
        failed,
        enrolled,
        daemonFollowed,
        daemonFailed,
        forgotten,
      };
      for (const [name, result] of Object.entries(results)) {
        expect({ name, raw: result.stdout.includes(raw) }).toEqual({ name, raw: false });
        expect({ name, shown: result.stdout.includes(shown) }).toEqual({ name, shown: true });
      }
    },
  );
});
