import { describe, expect, it } from "vitest";
import {
  FakeClock,
  FakeDaemonLauncher,
  MemoryFilesystem,
  MemoryIpcTransport,
  FakeSystemStats,
} from "../ports/index.js";
import { waitingRequestSchema } from "../contract/index.js";
import type { DeviceRecoveredPush, DeviceUnhealthyPush } from "../simlock-client/client.js";
import { runCli, type CliEnvironment } from "./index.js";
import { buildCliEnvironment } from "./environment.js";
import {
  fakeClient,
  gibibyte,
  outputCapture,
  realCliEnvironmentPorts,
  settle,
} from "./test-index.js";

// why: a part of a decomposed module: the lease tests build the environment with the part that
// owns it, buildCliEnvironment, where a test needs the ports wired its own way (ADR 0063 section 2).
describe("CLI: auto-launch's daemon that exits while starting (#760)", () => {
  it("status fails at once with the daemon's start error when the launched daemon exits with a fatal line", async () => {
    const clock = new FakeClock(0);
    const fatal = JSON.stringify({
      message: "Daemon failed to start",
      fields: { message: "Found /simlock/state.json, remove it" },
    });
    const launcher = new FakeDaemonLauncher(undefined, {
      exit: { code: 1, signal: null },
      output: `older line\n${fatal}\n`,
    });
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(clock.now()).toBeLessThan(20_000);
    expect(await exitCode).toBe(1);
    expect(JSON.parse(output.stderr)).toEqual({
      error: {
        code: "DAEMON_STARTUP_FAILED",
        message: "The daemon could not start: Found /simlock/state.json, remove it",
      },
    });
  });

  it("status names the exit code when the launched daemon's output cannot be read", async () => {
    const clock = new FakeClock(0);
    const launcher = {
      launch: async () => ({
        exited: Promise.resolve({ code: 3, signal: null }),
        readOutput: async (): Promise<string> => {
          throw new Error("daemon.log was replaced");
        },
      }),
    };
    const output = outputCapture({
      filesystem: new MemoryFilesystem(),
      clock,
      systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
      ipc: new MemoryIpcTransport(),
      launcher,
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      homeDirectory: "/home/operator",
      workingDirectory: "/work/project",
      hostPlatform: "linux",
      runTool: async () => ({ outcome: "not-found" }),
    });
    let settled = false;
    const exitCode = runCli(["status"], output.environmentWith()).then((code) => {
      settled = true;
      return code;
    });
    for (let tick = 0; tick < 100 && !settled; tick += 1) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(settled, "status had not settled by 5 s").toBe(true);
    expect(await exitCode).toBe(1);
    expect(JSON.parse(output.stderr).error.message).toBe(
      "The daemon exited with code 3 while starting; see `simlock daemon logs`",
    );
  });
});

describe("CLI: token operations go through the daemon", () => {
  it("token create/list/revoke all go through the client, not a local TokenStore", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      createToken: (input) => {
        calls.push("create");
        return Promise.resolve({
          secret: "sec_1",
          token: { id: "tok_1", role: input.role, createdAt: 0 },
        });
      },
      listTokens: () => {
        calls.push("list");
        return Promise.resolve({ tokens: [{ id: "tok_1", role: "operator", createdAt: 0 }] });
      },
      revokeToken: () => {
        calls.push("revoke");
        return Promise.resolve({ revoked: true });
      },
    });
    const environment = outputCapture().environmentWith({ connectAdmin: async () => client });
    await runCli(["token", "create", "--role", "operator"], environment);
    await runCli(["token", "list"], environment);
    await runCli(["token", "revoke", "tok_1"], environment);
    expect(calls).toEqual(["create", "list", "revoke"]);
  });
});

describe("CLI: lease pushes and exit codes (own logic, not the dispatcher's)", () => {
  it("writes {push:...} stderr lines for progress, device-unhealthy, and device-recovered as contract values", async () => {
    const output = outputCapture();
    let unhealthyListener: ((push: DeviceUnhealthyPush) => void) | undefined;
    let recoveredListener: ((push: DeviceRecoveredPush) => void) | undefined;
    const client = fakeClient({
      onDeviceUnhealthy: (listener) => {
        unhealthyListener = listener;
        return () => {};
      },
      onDeviceRecovered: (listener) => {
        recoveredListener = listener;
        return () => {};
      },
      requestLease: (_input, options) => {
        options?.onProgress?.({ stage: "provisioning", etaMs: 1_500 });
        unhealthyListener?.({ leaseId: "lse_1", deviceId: "dev_1" });
        recoveredListener?.({ leaseId: "lse_1", deviceId: "dev_1", attempts: 2 });
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    const lines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual({ push: "progress", stage: "provisioning", etaMs: 1_500 });
    expect(lines).toContainEqual({
      push: "device-unhealthy",
      leaseId: "lse_1",
      deviceId: "dev_1",
    });
    expect(lines).toContainEqual({
      push: "device-recovered",
      leaseId: "lse_1",
      deviceId: "dev_1",
      attempts: 2,
    });
  });

  it("maps --mode and --no-wait onto the contract's mode/noWait input fields", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      [
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 17 Pro",
        "--detach",
        "--mode",
        "slim",
        "--no-wait",
      ],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(capturedInput?.mode).toBe("slim");
    expect(capturedInput?.noWait).toBe(true);
  });

  // why: the real environment builder reads `SIMLOCK_BASELINE`, so the rows below prove the variable, not a hand-set field.
  const fromEnv = (value: string): Partial<CliEnvironment> => {
    const { baselineFromEnv } = buildCliEnvironment(realCliEnvironmentPorts(), {
      SIMLOCK_BASELINE: value,
    });
    return baselineFromEnv === undefined ? {} : { baselineFromEnv };
  };

  it.each([
    {
      flag: "--image-tag",
      field: "imageTag",
      value: "google_apis_playstore",
      lease: ["lease", "--platform", "android", "--device", "Pixel 8", "--detach"],
      flagArgs: ["--image-tag", "google_apis_playstore"],
      envOverride: () => ({}),
    },
    {
      flag: "--except",
      field: "except",
      value: ["store", "other"],
      lease: ["lease", "--platform", "ios", "--mode", "slim", "--detach"],
      flagArgs: ["--except", "store,other"],
      envOverride: () => ({}),
    },
    {
      flag: "--baseline",
      field: "baseline",
      value: "checkout",
      lease: ["lease", "--platform", "android", "--detach"],
      flagArgs: ["--baseline", "checkout"],
      envOverride: () => ({}),
    },
    {
      flag: "SIMLOCK_BASELINE",
      field: "baseline",
      value: "checkout",
      lease: ["lease", "--platform", "android", "--detach"],
      flagArgs: [],
      envOverride: () => fromEnv("checkout"),
    },
    {
      flag: "--baseline over SIMLOCK_BASELINE",
      field: "baseline",
      value: "other",
      lease: ["lease", "--platform", "android", "--detach"],
      flagArgs: ["--baseline", "other"],
      envOverride: () => fromEnv("checkout"),
    },
    {
      flag: "an empty SIMLOCK_BASELINE",
      field: "baseline",
      value: undefined,
      lease: ["lease", "--platform", "android", "--detach"],
      flagArgs: [],
      envOverride: () => fromEnv(""),
    },
    {
      flag: "--physical",
      field: "physical",
      value: true,
      lease: ["lease", "--platform", "ios", "--detach"],
      flagArgs: ["--physical"],
      envOverride: () => ({}),
    },
  ])(
    "maps $flag onto the contract's $field input field, and sends none without it",
    async ({ field, value, lease, flagArgs, envOverride }) => {
      const inputs: Record<string, unknown>[] = [];
      const client = fakeClient({
        requestLease: (input) => {
          inputs.push(input as unknown as Record<string, unknown>);
          return Promise.resolve({
            device: {
              class: "phone",
              driverDeviceId: "00008110-001A2B3C4D5E",
              id: "dev_1",
              physical: true,
              spec: {
                class: "phone",
                model: "iPhone 15 Pro",
                osVersion: "18.4",
                physical: true,
                platform: "ios",
              },
            },
            environment: {},
            lease: {
              id: "lse_1",
              deviceId: "dev_1",
              requesterId: "test-requester",
              ownerId: "test-requester",
              grantedAt: 0,
              lastRenewedAt: 0,
              idChosenByRequester: false,
              ttlMs: 60_000,
              ttlDeadline: 60_000,
            },
            timing: {
              estimatedProvisionMs: 0,
              estimatedBootMs: 0,
              estimatedReclaimMs: 0,
              estimatedReadyMs: 0,
            },
          });
        },
      });

      await runCli(
        [...lease, ...flagArgs],
        outputCapture().environmentWith({ connectAdmin: async () => client, ...envOverride() }),
      );
      await runCli(lease, outputCapture().environmentWith({ connectAdmin: async () => client }));

      expect(inputs[0]?.[field]).toEqual(value);
      expect(inputs[1]).not.toHaveProperty(field);
    },
  );

  it("fails the removed full flag as an unknown option, before connecting", async () => {
    const output = outputCapture();
    let connected = false;
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--full"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({});
        },
      }),
    );
    expect(exitCode).toBe(2);
    expect(connected).toBe(false);
    expect(output.stderr).toContain("--full");
  });

  it("omits mode and reports noWait: false when neither flag is given", async () => {
    const output = outputCapture();
    let capturedInput: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        capturedInput = input as unknown as Record<string, unknown>;
        return Promise.resolve({
          device: {
            physical: false,
            id: "dev_1",
            driverDeviceId: "dev_1",
            spec: { physical: false, platform: "ios", model: "x", osVersion: "26.5" },
            mode: "full",
          },
          environment: {},
          lease: {
            id: "lse_1",
            deviceId: "dev_1",
            requesterId: "test-requester",
            ownerId: "test-requester",
            grantedAt: 0,
            lastRenewedAt: 0,
            idChosenByRequester: false,
            ttlMs: 60_000,
            ttlDeadline: 60_000,
          },
          timing: {
            estimatedProvisionMs: 0,
            estimatedBootMs: 0,
            estimatedReclaimMs: 0,
            estimatedReadyMs: 0,
          },
        });
      },
    });
    await runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    expect(capturedInput).not.toHaveProperty("mode");
    expect(capturedInput?.noWait).toBe(false);
  });
});

describe("CLI: holder renew and release (ADR 0004 §2)", () => {
  it("stops renewing when the lease is lost, and still does not re-release it", async () => {
    const clock = new FakeClock(0);
    const output = outputCapture();
    let leaseLostListener:
      | ((push: { leaseId: string; deviceId: string; reason: string }) => void)
      | undefined;
    let renewed = 0;
    let released = false;
    const client = fakeClient({
      onLeaseLost: (listener) => {
        leaseLostListener = listener;
        return () => {};
      },
      renewLease: (input) => {
        renewed += 1;
        return Promise.resolve({
          deviceId: "dev_1",
          grantedAt: 0,
          id: input.leaseId,
          ownerId: "test-requester",
          requesterId: "test-requester",
          lastRenewedAt: 0,
          idChosenByRequester: false,
          ttlMs: 60_000,
          ttlDeadline: clock.now() + 60_000,
        });
      },
      releaseLease: () => {
        released = true;
        return Promise.resolve({ leaseId: "lse_1" });
      },
    });
    const runPromise = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({ clock, connectAdmin: async () => client }),
    );
    await settle();
    leaseLostListener?.({ deviceId: "dev_1", leaseId: "lse_1", reason: "ttl-backstop" });

    expect(await runPromise).toBe(14);
    expect(released).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
    clock.advance(600_000);
    expect(renewed).toBe(0);
  });
});

describe("simlock list --requests", () => {
  it("prints a starting request without a place in the queue, one on a worker with that worker, and a future timestamp as waiting 0s", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      list: async (input) => {
        asked.push(input);
        return [
          {
            createdAt: -12_000,
            id: "req_1",
            requesterId: "agent-b",
            spec: { imageTag: "google_apis", model: "Pixel 8", platform: "android" },
            stage: "starting",
          },
          {
            createdAt: -3_400,
            id: "req_2",
            queuePosition: 2,
            requesterId: "local-agent",
            spec: { model: "iPhone 16", osVersion: "18.4", platform: "ios" },
            stage: "queued",
            workerId: "wrk_1",
          },
          {
            // why: Stamped by a worker whose clock runs ahead of this one.
            createdAt: 5_000,
            id: "req_3",
            queuePosition: 1,
            requesterId: "skewed-agent",
            spec: { model: "iPhone 16", platform: "ios" },
            stage: "queued",
            workerId: "wrk_2",
          },
          {
            createdAt: -1_000,
            id: "req_4",
            queuePosition: 3,
            requesterId: "baseline-agent",
            spec: { baseline: "checkout", platform: "ios" },
            stage: "queued",
          },
        ];
      },
    });

    await expect(
      runCli(["list", "--requests"], output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ kind: "requests" }]);
    expect(output.stdout).toBe(
      "Request req_1: agent-b, android Pixel 8 image tag google_apis, starting, waiting 12s\n" +
        "Request req_2: local-agent on wrk_1, ios iPhone 16 18.4, queued at 2, waiting 3s\n" +
        "Request req_3: skewed-agent on wrk_2, ios iPhone 16, queued at 1, waiting 0s\n" +
        "Request req_4: baseline-agent, ios baseline checkout, queued at 3, waiting 1s\n",
    );
  });

  describe("the reason a queued request waits", () => {
    const queued = (
      reason: string | undefined,
      platform: "ios" | "android" = "ios",
    ): Record<string, unknown> => ({
      createdAt: 0,
      id: "req_1",
      queuePosition: 1,
      requesterId: "agent",
      spec: { model: "Device", platform },
      stage: "queued",
      ...(reason === undefined ? {} : { reason }),
    });

    async function printed(entry: Record<string, unknown>): Promise<string> {
      const output = outputCapture();
      const client = fakeClient({ list: async () => [entry] as never });
      await runCli(
        ["list", "--requests"],
        output.environmentWith({ connectAdmin: async () => client }),
      );
      return output.stdout.trimEnd();
    }

    it.each([
      ["behind-earlier-request", "ios", "behind an earlier request"],
      ["device-limit", "ios", "full: device limit"],
      ["ram-budget", "ios", "full: RAM budget"],
      ["memory-pressure", "ios", "full: host memory pressure"],
      ["global-running-limit", "ios", "full: running limit"],
      ["platform-running-limit", "ios", "full: running limit for iOS"],
      ["platform-running-limit", "android", "full: running limit for Android"],
      ["waiting-for-device", "ios", "a matching device is starting"],
      ["no-free-physical", "ios", "every matching device is leased or absent"],
    ] as const)(
      "ends the line of a queued request with %s on %s as ' — %s'",
      async (reason, platform, text) => {
        expect(await printed(queued(reason, platform))).toBe(
          `Request req_1: agent, ${platform} Device, queued at 1, waiting 0s — ${text}`,
        );
      },
    );

    it("ends the line of a queued request with no reason as it ended before", async () => {
      expect(await printed(queued(undefined))).toBe(
        "Request req_1: agent, ios Device, queued at 1, waiting 0s",
      );
    });

    it("has a text for every reason the contract's enum lists", async () => {
      const field = (waitingRequestSchema.shape as Record<string, unknown>)["reason"];
      expect(field).toBeDefined();
      const listed = (field as { unwrap(): { options: readonly string[] } }).unwrap().options;

      expect(listed.length).toBeGreaterThan(0);
      for (const reason of listed) {
        const line = await printed(queued(reason));
        expect(line).toMatch(/ — [a-z]/);
        expect(line).not.toContain(reason);
      }
    });
  });

  describe("the reason each worker cannot take a request on a gateway", () => {
    const gatewayEntry = (
      workers: readonly Record<string, unknown>[],
      platform: "ios" | "android" = "ios",
    ): Record<string, unknown> => ({
      createdAt: 0,
      id: "req_1",
      queuePosition: 1,
      requesterId: "ci",
      spec: { model: "Device", platform },
      stage: "queued",
      workers,
    });

    async function printedGateway(
      entries: readonly Record<string, unknown>[],
      known: readonly { id: string; label?: string }[] = [],
    ): Promise<{ stdout: string; listed: number }> {
      const output = outputCapture();
      let listed = 0;
      const client = fakeClient({
        list: async () => entries as never,
        listWorkers: () => {
          listed += 1;
          return Promise.resolve({
            workers: known.map((worker) => ({
              catalog: [],
              connection: "connected" as const,
              devices: [],
              drained: false,
              lastSeenAt: 1,
              leases: [],
              ...worker,
            })),
          } as never);
        },
      });
      await runCli(
        ["list", "--requests"],
        output.environmentWith({ connectAdmin: async () => client }),
      );
      return { listed, stdout: output.stdout };
    }

    it("prints one indented line per worker under the request, named by its label, else its id", async () => {
      const { stdout } = await printedGateway(
        [
          gatewayEntry([
            { reason: "drained", workerId: "wrk_a" },
            { capacityReason: "platform-running-limit", reason: "full", workerId: "wrk_b" },
            { reason: "runtime-missing", workerId: "wrk_c" },
            { reason: "busy", workerId: "wrk_d" },
          ]),
        ],
        [{ id: "wrk_a", label: "mac-mini-1" }, { id: "wrk_b" }, { id: "wrk_c", label: "lab" }],
      );

      expect(stdout).toBe(
        "Request req_1: ci, ios Device, queued at 1, waiting 0s\n" +
          "  mac-mini-1: drained\n" +
          "  wrk_b: full: running limit for iOS\n" +
          "  lab: oS not installed\n" +
          "  wrk_d: busy with its own queue\n",
      );
    });

    it.each([
      ["disconnected", "ios", undefined, "not connected"],
      ["incompatible", "ios", undefined, "protocol mismatch"],
      ["not-ready", "ios", undefined, "not ready yet"],
      ["unhealthy", "ios", undefined, "not running"],
      ["updating", "ios", undefined, "updating"],
      ["drained", "ios", undefined, "drained"],
      ["busy", "ios", undefined, "busy with its own queue"],
      ["no-driver", "ios", undefined, "no iOS support"],
      ["no-driver", "android", undefined, "no Android support"],
      ["unknown-model", "ios", undefined, "model not offered"],
      ["runtime-missing", "ios", undefined, "oS not installed"],
      ["capability-missing", "ios", undefined, "missing capability"],
      ["full", "ios", undefined, "full"],
      ["full", "ios", "device-limit", "full: device limit"],
      ["full", "ios", "ram-budget", "full: RAM budget"],
      ["full", "ios", "memory-pressure", "full: host memory pressure"],
      ["full", "ios", "global-running-limit", "full: running limit"],
      ["full", "ios", "platform-running-limit", "full: running limit for iOS"],
      ["full", "android", "platform-running-limit", "full: running limit for Android"],
      ["no-free-physical", "ios", undefined, "every matching device is leased or absent"],
      ["not-chosen", "ios", undefined, "not chosen this time"],
      ["no-baseline", "ios", undefined, "does not hold the baseline"],
      ["baseline-stale", "ios", undefined, "baseline is stale"],
      ["baseline-mismatch", "ios", undefined, "baseline is for another device"],
    ] as const)(
      "prints %s on %s with capacity reason %s as '  wrk_a: %s'",
      async (reason, platform, capacityReason, text) => {
        const { stdout } = await printedGateway([
          gatewayEntry(
            [
              {
                ...(capacityReason === undefined ? {} : { capacityReason }),
                reason,
                workerId: "wrk_a",
              },
            ],
            platform,
          ),
        ]);

        expect(stdout.split("\n")[1]).toBe(`  wrk_a: ${text}`);
      },
    );

    it("asks worker.list once for names, and not at all when no entry has workers", async () => {
      const gateway = await printedGateway([
        gatewayEntry([{ reason: "drained", workerId: "wrk_a" }]),
        { ...gatewayEntry([{ reason: "busy", workerId: "wrk_a" }]), id: "req_2" },
      ]);
      const plain = await printedGateway([{ ...gatewayEntry([]), workers: undefined }]);

      expect(gateway.listed).toBe(1);
      expect(plain.listed).toBe(0);
    });

    it("prints a worker's own entry with its reason after ' — ' and no indented lines", async () => {
      const { stdout } = await printedGateway([
        {
          ...gatewayEntry([]),
          reason: "ram-budget",
          workers: undefined,
          workerId: "wrk_1",
        },
      ]);

      expect(stdout).toBe(
        "Request req_1: ci on wrk_1, ios Device, queued at 1, waiting 0s — full: RAM budget\n",
      );
    });

    it("has a text for every gateway reason the contract's enum lists", async () => {
      const field = (waitingRequestSchema.shape as Record<string, unknown>)["workers"];
      expect(field).toBeDefined();
      const element = (
        field as { unwrap(): { element: { shape: { reason: { options: readonly string[] } } } } }
      ).unwrap().element;
      const listed = element.shape.reason.options;

      expect(listed.length).toBeGreaterThan(0);
      for (const reason of listed) {
        const { stdout } = await printedGateway([gatewayEntry([{ reason, workerId: "wrk_a" }])]);
        const line = stdout.split("\n")[1] ?? "";
        expect(line).toMatch(/^ {2}wrk_a: [a-zA-Z]/);
        expect(line).not.toContain("-");
      }
    });
  });

  it.each([["--devices"], ["--leases"], ["--rules"]])(
    "exits 2 with USAGE for --requests beside %s, without asking the daemon",
    async (other) => {
      const output = outputCapture();
      let listed = 0;
      const client = fakeClient({
        list: () => {
          listed += 1;
          return Promise.resolve([]);
        },
      });

      await expect(
        runCli(
          ["list", "--requests", other],
          output.environmentWith({ connectAdmin: async () => client }),
        ),
      ).resolves.toBe(2);
      expect(listed).toBe(0);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
        error: { code: "USAGE" },
      });
    },
  );
});

describe("simlock lease: a request names a model, a class, or nothing", () => {
  const grant = {
    device: {
      physical: false,
      driverDeviceId: "dev_1",
      id: "dev_1",
      mode: "full" as const,
      spec: { physical: false, model: "iPhone 17", osVersion: "26.5", platform: "ios" as const },
    },
    environment: {},
    lease: {
      deviceId: "dev_1",
      grantedAt: 0,
      id: "lse_1",
      lastRenewedAt: 0,
      idChosenByRequester: false,
      ownerId: "test-requester",
      requesterId: "test-requester",
      ttlDeadline: 60_000,
      ttlMs: 60_000,
    },
    timing: {
      estimatedBootMs: 0,
      estimatedProvisionMs: 0,
      estimatedReadyMs: 0,
      estimatedReclaimMs: 0,
    },
  };

  async function sentFor(args: readonly string[]): Promise<Record<string, unknown> | undefined> {
    let sent: Record<string, unknown> | undefined;
    const client = fakeClient({
      requestLease: (input) => {
        sent = input as unknown as Record<string, unknown>;
        return Promise.resolve(grant);
      },
    });
    const output = outputCapture();
    await runCli(
      ["lease", ...args, "--detach"],
      output.environmentWith({ connectAdmin: async () => client }),
    );
    return sent;
  }

  it.each([
    {
      name: "neither model nor class for a lease with only a platform",
      args: ["--platform", "ios"],
      present: { platform: "ios" },
      absent: ["model", "class"],
    },
    {
      name: "the class for --class, and no model",
      args: ["--platform", "ios", "--class", "phone"],
      present: { class: "phone", platform: "ios" },
      absent: ["model"],
    },
    {
      name: "both fields for --class beside --device, leaving the refusal to the daemon",
      args: ["--platform", "ios", "--class", "phone", "--device", "iPhone 16"],
      present: { class: "phone", model: "iPhone 16", platform: "ios" },
      absent: [],
    },
  ])("sends $name", async ({ args, present, absent }) => {
    const sent = await sentFor(args);

    expect(sent).toMatchObject(present);
    for (const key of absent) expect(sent).not.toHaveProperty(key);
  });

  it("names --class in the lease usage text, with --device optional", async () => {
    const output = outputCapture();

    await runCli(["lease", "--help"], output.environmentWith({}));

    expect(output.stdout).toBe(
      "Usage: simlock lease --platform <ios|android> [--device <model> | --class <class>]\n" +
        "                     [--os <version|range>] [--mode <slim|full>] [--image-tag <tag>] [--agent-id <id>]\n" +
        "                     [--except <category,...>] [--baseline <name>]\n" +
        "                     [--timeout <duration>] [--lease-id <id>] [--physical]\n" +
        "                     [--no-wait] [--detach] [--ttl <duration>] [--allow-download]\n" +
        "                     [--run <id>] [--label <text>] [--meta <key=value>]... [--export-env] [--bind-pid <pid>]\n",
    );
  });

  it.each([
    ["--device", "lease --device must not be empty"],
    ["--class", "lease --class must not be empty"],
  ])("exits 2 with USAGE for an empty %s, before connecting", async (flag, message) => {
    const output = outputCapture();
    let connected = false;

    const exitCode = await runCli(
      ["lease", "--platform", "ios", flag, ""],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({});
        },
      }),
    );

    expect(exitCode).toBe(2);
    expect(connected).toBe(false);
    expect(output.stderr).toContain(message);
  });

  it("prints the class of a waiting request that names no model, phone when it names none", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { class: "watch", platform: "ios" },
          stage: "queued",
        },
        {
          createdAt: 0,
          id: "req_2",
          queuePosition: 2,
          requesterId: "b",
          spec: { platform: "android" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios class watch, queued at 1, waiting 0s\n" +
        "Request req_2: b, android class phone, queued at 2, waiting 0s\n",
    );
  });

  it("prints physical in a waiting physical request's line, and nothing for a simulator request", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { model: "iPhone 15 Pro", physical: true, platform: "ios" },
          stage: "queued",
        },
        {
          createdAt: 0,
          id: "req_2",
          queuePosition: 1,
          requesterId: "b",
          spec: { model: "iPhone 16", platform: "ios" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios physical iPhone 15 Pro, queued at 1, waiting 0s\n" +
        "Request req_2: b, ios iPhone 16, queued at 1, waiting 0s\n",
    );
  });

  it("prints a waiting request's OS range as typed", async () => {
    const output = outputCapture();
    const client = fakeClient({
      list: async () => [
        {
          createdAt: 0,
          id: "req_1",
          queuePosition: 1,
          requesterId: "a",
          spec: { osVersion: ">=18 <26", platform: "ios" },
          stage: "queued",
        },
      ],
    });

    await runCli(
      ["list", "--requests"],
      output.environmentWith({ connectAdmin: async () => client }),
    );

    expect(output.stdout).toBe(
      "Request req_1: a, ios class phone >=18 <26, queued at 1, waiting 0s\n",
    );
  });
});
