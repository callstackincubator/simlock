import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import type { SimlockAdminClient, StatusGetOutput } from "../simlock-client/client.js";
import { type WorkerView } from "../admin/index.js";
import { runCli } from "./index.js";
import { EMPTY_STATUS, fakeClient, outputCapture } from "./test-index.js";

describe("CLI: worker commands (ADR 0005 §8/§23)", () => {
  const connectedWorker = {
    capacity: {
      android: {
        atRamBudget: false,
        limit: 2,
        maxRunning: 2,
        overLimit: false,
        reserved: 0,
        running: 0,
        used: 0,
        warm: 0,
      },
      global: { maxRunning: 4, overLimit: false, reserved: 0, running: 1, warm: 1 },
      ios: {
        atRamBudget: false,
        limit: 2,
        maxRunning: 2,
        overLimit: false,
        reserved: 0,
        running: 1,
        used: 1,
        warm: 1,
      },
    },
    catalog: [],
    connection: "connected" as const,
    devices: [],
    drained: false,
    id: "wrk_1",
    label: "mac-mini-1",
    lastSeenAt: 1_000,
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
      },
    ],
  };

  it("renders each worker's state, capacity and lease count", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers: [connectedWorker] }) }),
    });

    await expect(runCli(["worker", "list"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("wrk_1 (mac-mini-1): connected -- ios 1/2");
    // why: No host facts on this view yet, so the line ends at the lease count.
    expect(output.stdout).toContain("1 lease(s)\n");
  });

  it("prints each worker's operating system, architecture, and tool versions", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  host: {
                    arch: "arm64",
                    os: "macOS",
                    osVersion: "15.5",
                    tools: [
                      { build: "16F6", name: "xcode", platform: "ios" as const, version: "16.4" },
                      { name: "emulator", platform: "android" as const, version: "35.4.9" },
                    ],
                  },
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain(
      "1 lease(s) -- macOS 15.5 arm64; xcode 16.4 (16F6), emulator 35.4.9",
    );
  });

  describe("a worker's Load line", () => {
    const GIB = 2 ** 30;
    const PARTS = {
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
    const READING =
      "CPU 34% busy (10 cores) · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk 112.4 GiB of 494.4 GiB free";
    const NOW = 61_000;
    const install = {
      component: "26.4",
      platform: "ios" as const,
      since: 1_000,
      state: "downloading" as const,
      waiters: 2,
    };
    const printWorkers = async (workers: unknown[]) => {
      const output = outputCapture();
      await runCli(
        ["worker", "list"],
        output.environmentWith({
          clock: new FakeClock(NOW),
          connectAdmin: async () =>
            fakeClient({ listWorkers: () => Promise.resolve({ workers } as never) }),
        }),
      );
      return output.stdout;
    };

    it("simlock worker list prints a connected or starting worker's Load line after its own line and before its install lines", async () => {
      const stdout = await printWorkers([
        {
          ...connectedWorker,
          installs: [install],
          load: { ...PARTS, readAt: NOW - 12_000 },
        },
        {
          connection: "connected",
          drained: false,
          health: "starting",
          id: "wrk_2",
          lastSeenAt: 1,
          load: { memory: PARTS.memory, readAt: NOW - 3_000 },
        },
      ]);

      const lines = stdout.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^wrk_1 \(mac-mini-1\): connected -- /);
      expect(lines[1]).toBe(`  Load: ${READING} · read 12s ago`);
      expect(lines[2]).toMatch(/^ {2}Install ios 26\.4: downloading for 60s, 2 waiters$/);
      expect(lines[3]).toMatch(/^wrk_2: connected, starting/);
      expect(lines[4]).toBe(
        "  Load: CPU unavailable · memory 9.8 GiB of 32.0 GiB available · swap 1.2 GiB used · pressure normal · disk unavailable · read 3s ago",
      );
    });

    it("simlock worker list prints `no reading while disconnected` for a disconnected worker, and no Load line for an incompatible one or one that sent none", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, connection: "disconnected", drained: true, id: "wrk_a" },
        {
          connection: "incompatible",
          drained: false,
          id: "wrk_b",
          lastSeenAt: 1,
          protocol: { gateway: { max: 35, min: 35 }, worker: { max: 4, min: 4 } },
        },
        { ...connectedWorker, id: "wrk_c" },
        { ...connectedWorker, id: "wrk_d", load: { ...PARTS, readAt: NOW - 1_000 } },
      ]);

      const lines = stdout.trimEnd().split("\n");
      const loadAfter = (id: string) => {
        const index = lines.findIndex(
          (line) => line.startsWith(`${id}:`) || line.startsWith(`${id} (`),
        );
        const next = lines[index + 1];
        return next?.startsWith("  Load:") === true ? next : undefined;
      };
      expect(loadAfter("wrk_d")).toBe(`  Load: ${READING} · read 1s ago`);
      expect(loadAfter("wrk_a")).toBe("  Load: no reading while disconnected");
      expect(loadAfter("wrk_b")).toBeUndefined();
      expect(loadAfter("wrk_c")).toBeUndefined();
    });

    it("simlock worker list prints `read 0s ago` for a readAt ahead of its clock", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, load: { ...PARTS, readAt: NOW + 9_000 } },
      ]);

      expect(stdout).toContain(`  Load: ${READING} · read 0s ago\n`);
    });

    it("simlock worker list rounds a reading's age up to whole seconds", async () => {
      const stdout = await printWorkers([
        { ...connectedWorker, load: { ...PARTS, readAt: NOW - 1_001 } },
      ]);

      expect(stdout).toContain(`  Load: ${READING} · read 2s ago\n`);
    });

    it("simlock status against a gateway prints the gateway's own Load line, and each worker's Load line aged from the status time", async () => {
      const output = outputCapture();
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
        load: { ageMs: 4_000, ...PARTS },
        workers: [
          {
            catalog: [],
            connection: "connected",
            devices: [],
            drained: false,
            id: "wrk_1",
            lastSeenAt: 1,
            leases: [],
            load: { ...PARTS, readAt: NOW - 12_000 },
          },
        ],
      };

      await runCli(
        ["status"],
        output.environmentWith({
          clock: new FakeClock(NOW),
          connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status) }),
        }),
      );

      expect(output.stdout).toContain(`\nLoad: ${READING} · read 4s ago\n`);
      expect(output.stdout).toContain(`\n  Load: ${READING} · read 12s ago\n`);
    });
  });

  it("prints a starting worker as starting, with its leases unknown rather than none", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  connection: "connected" as const,
                  drained: true,
                  health: "starting" as const,
                  id: "wrk_1",
                  lastSeenAt: 1,
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toBe(
      "wrk_1: connected, starting, drained -- capacity unknown, leases unknown\n",
    );
  });

  it("prints each worker's installs in progress under it", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      clock: new FakeClock(61_000),
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  installs: [
                    {
                      component: "26.4",
                      platform: "ios" as const,
                      since: 1_000,
                      state: "downloading" as const,
                      waiters: 2,
                    },
                  ],
                },
                {
                  ...connectedWorker,
                  id: "wrk_2",
                  installs: [
                    {
                      component: "35",
                      platform: "android" as const,
                      since: 31_000,
                      state: "waiting" as const,
                      waiters: 1,
                    },
                  ],
                },
                { ...connectedWorker, id: "wrk_3", installs: [] },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain(
      "1 lease(s)\n  Install ios 26.4: downloading for 60s, 2 waiters\nwrk_2 (mac-mini-1): connected",
    );
    expect(output.stdout).toContain(
      "1 lease(s)\n  Install android 35: waiting for 30s, 1 waiter\nwrk_3 (mac-mini-1): connected",
    );
    expect(output.stdout.match(/Install /g)).toHaveLength(2);
  });

  it("says so plainly when no worker has ever connected", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({ connectAdmin: async () => fakeClient() });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain("No workers have connected");
  });

  it("names the protocol skew on an incompatible worker", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          listWorkers: () =>
            Promise.resolve({
              workers: [
                {
                  ...connectedWorker,
                  connection: "incompatible" as const,
                  leases: [],
                  protocol: { gateway: { max: 5, min: 5 }, worker: { max: 4, min: 4 } },
                },
              ],
            }),
        }),
    });

    await runCli(["worker", "list"], environment);

    expect(output.stdout).toContain("incompatible");
    expect(output.stdout).toContain("protocol 4-4 vs gateway 5-5");
  });

  it("worker list shows a worker's version, the latest only when newer, and its update stage", async () => {
    const waiting = {
      forced: false,
      from: "0.3.0",
      leases: 2,
      stage: "waiting",
      startedAt: 1_000,
      to: "0.4.0",
    } as const;
    const cases: readonly {
      expected: string;
      latestVersion: string | null;
      update: WorkerView["update"];
      version: string | undefined;
    }[] = [
      {
        expected: " -- simlock 0.3.0 (0.4.0 available) -- updating to 0.4.0: waiting for 2 leases",
        latestVersion: "0.4.0",
        update: waiting,
        version: "0.3.0",
      },
      {
        expected: " -- simlock 0.3.0 (0.4.0 available) -- updating to 0.4.0: installing",
        latestVersion: "0.4.0",
        update: {
          forced: false,
          from: "0.3.0",
          stage: "installing",
          startedAt: 1_000,
          to: "0.4.0",
        },
        version: "0.3.0",
      },
      {
        expected: " -- updating to 0.4.0: waiting for 1 lease",
        latestVersion: null,
        update: { ...waiting, leases: 1 },
        version: undefined,
      },
      { expected: " -- simlock 0.4.0", latestVersion: "0.4.0", update: null, version: "0.4.0" },
      { expected: " -- simlock 0.5.0", latestVersion: "0.4.0", update: null, version: "0.5.0" },
      { expected: " -- simlock 0.4.0", latestVersion: null, update: null, version: "0.4.0" },
    ];
    for (const { expected, latestVersion, update, version } of cases) {
      const output = outputCapture();
      const worker = {
        ...connectedWorker,
        latestVersion,
        update,
        ...(version === undefined ? {} : { version }),
      };
      const environment = output.environmentWith({
        connectAdmin: async () =>
          fakeClient({ listWorkers: () => Promise.resolve({ workers: [worker] }) }),
      });

      await runCli(["worker", "list"], environment);

      expect(output.stdout.trimEnd().slice(-expected.length)).toBe(expected);
      if (!expected.includes("available")) expect(output.stdout).not.toContain("available");
      if (update === null) expect(output.stdout).not.toContain("updating");
    }
  });

  it("emits the raw contract value under --json", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers: [connectedWorker] }) }),
    });

    await runCli(["worker", "list", "--json"], environment);

    expect(JSON.parse(output.stdout)).toMatchObject({ workers: [{ id: "wrk_1" }] });
  });

  it("drains, undrains and removes by id", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      drainWorker: (input) => {
        calls.push(`drain:${input.workerId}`);
        return Promise.resolve({ drained: true as const, workerId: input.workerId });
      },
      removeWorker: (input) => {
        calls.push(`remove:${input.workerId}`);
        return Promise.resolve({ removed: true, workerId: input.workerId });
      },
      undrainWorker: (input) => {
        calls.push(`undrain:${input.workerId}`);
        return Promise.resolve({ drained: false as const, workerId: input.workerId });
      },
    });
    const environment = outputCapture().environmentWith({ connectAdmin: async () => client });

    await expect(runCli(["worker", "drain", "wrk_1"], environment)).resolves.toBe(0);
    await expect(runCli(["worker", "undrain", "wrk_1"], environment)).resolves.toBe(0);
    await expect(runCli(["worker", "remove", "wrk_2"], environment)).resolves.toBe(0);

    expect(calls).toEqual(["drain:wrk_1", "undrain:wrk_1", "remove:wrk_2"]);
  });

  it("requires a worker id, and rejects an unknown subcommand", async () => {
    const environment = outputCapture().environmentWith({
      connectAdmin: async () => fakeClient(),
    });

    await expect(runCli(["worker", "drain"], environment)).resolves.toBe(2);
    await expect(runCli(["worker", "explode"], environment)).resolves.toBe(2);
  });

  it("prints usage without connecting to anything", async () => {
    const output = outputCapture();
    let connected = false;
    const environment = output.environmentWith({
      connectAdmin: async () => {
        connected = true;
        return fakeClient();
      },
    });

    await expect(runCli(["worker"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("simlock worker list");
    expect(connected).toBe(false);
  });

  it("mints a worker join token (ADR 0005 §8)", async () => {
    const roles: string[] = [];
    const client = fakeClient({
      createToken: (input) => {
        roles.push(input.role);
        return Promise.resolve({
          secret: "sec_join",
          token: { createdAt: 0, id: "tok_1", role: input.role },
        });
      },
    });
    const output = outputCapture();
    const environment = output.environmentWith({ connectAdmin: async () => client });

    await expect(runCli(["token", "create", "--role", "worker"], environment)).resolves.toBe(0);

    expect(roles).toEqual(["worker"]);
    expect(JSON.parse(output.stdout)).toMatchObject({ token: { role: "worker" } });
  });

  it("still rejects a role that is not one of the three", async () => {
    const environment = outputCapture().environmentWith({
      connectAdmin: async () => fakeClient(),
    });

    await expect(runCli(["token", "create", "--role", "root"], environment)).resolves.toBe(2);
  });
});

describe("CLI: a worker's capabilities", () => {
  const platform = {
    atRamBudget: false,
    limit: 2,
    maxRunning: 2,
    overLimit: false,
    reserved: 0,
    running: 0,
    used: 0,
    warm: 0,
  };
  const worker = (overrides: Record<string, unknown> = {}) => ({
    capacity: {
      android: platform,
      global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
      ios: platform,
    },
    catalog: [],
    connection: "connected" as const,
    devices: [],
    drained: false,
    id: "wrk_1",
    label: "mac-mini",
    lastSeenAt: 1_000,
    leases: [],
    ...overrides,
  });
  const listed = async (workers: unknown[]): Promise<string> => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ listWorkers: () => Promise.resolve({ workers } as never) }),
    });
    await runCli(["worker", "list"], environment);
    return output.stdout;
  };

  it("worker list prints ` -- agent-device available`, ` -- agent-device off` and ` -- agent-device unavailable: <reason>` on the worker's line", async () => {
    const shown = await listed([
      worker({ capabilities: [{ name: "agent-device", state: "available" }] }),
      worker({ capabilities: [{ name: "agent-device", state: "off" }], id: "wrk_2" }),
      worker({
        capabilities: [
          {
            name: "agent-device",
            reason: "found 0.20.1, need 0.21.28 or later",
            state: "unavailable",
          },
        ],
        id: "wrk_3",
      }),
      worker({
        capabilities: [{ name: "agent-device", reason: "starting", state: "unavailable" }],
        id: "wrk_4",
      }),
    ]);

    expect(shown).toContain("wrk_1 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s)");
    expect(shown).toMatch(/^wrk_1 .* -- agent-device available$/m);
    expect(shown).toMatch(/^wrk_2 .* -- agent-device off$/m);
    expect(shown).toMatch(
      /^wrk_3 .* -- agent-device unavailable: found 0\.20\.1, need 0\.21\.28 or later$/m,
    );
    expect(shown).toMatch(/^wrk_4 .* -- agent-device unavailable: starting$/m);
  });

  it("simlock worker list shows each worker's memory step as the end of its first line, and nothing at none, with no field, or for a disconnected worker", async () => {
    const withStep = (
      id: string,
      step: "none" | "warming-paused" | "new-devices-paused",
      extra = {},
    ) =>
      worker({
        capabilities: [{ name: "agent-device", state: "available" }],
        capacity: { ...worker().capacity, memoryPressure: { step } },
        id,
        ...extra,
      });
    const shown = await listed([
      withStep("wrk_1", "warming-paused"),
      withStep("wrk_2", "new-devices-paused"),
      withStep("wrk_3", "none"),
      worker({ id: "wrk_4" }),
      withStep("wrk_5", "new-devices-paused", { connection: "disconnected" }),
    ]);

    const lines = shown.trimEnd().split("\n");
    const first = (id: string) => lines.find((line) => line.startsWith(`${id} `));
    expect(first("wrk_1")).toBe(
      "wrk_1 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s) -- agent-device available -- memory: warming paused",
    );
    expect(first("wrk_2")).toBe(
      "wrk_2 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s) -- agent-device available -- memory: new devices paused",
    );
    expect(first("wrk_3")).toBe(
      "wrk_3 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s) -- agent-device available",
    );
    expect(first("wrk_4")).toBe("wrk_4 (mac-mini): connected -- ios 0/2, android 0/2, 0 lease(s)");
    expect(first("wrk_5")).toBe(
      "wrk_5 (mac-mini): disconnected -- ios 0/2, android 0/2, 0 lease(s) -- agent-device available",
    );
  });

  it("worker list prints two entries in the order the worker sent them", async () => {
    const shown = await listed([
      worker({
        capabilities: [
          { name: "zeta", state: "off" },
          { name: "agent-device", state: "available" },
        ],
      }),
    ]);

    expect(shown).toMatch(/^wrk_1 .* -- zeta off -- agent-device available$/m);
  });

  it("worker list prints nothing for a worker whose list is absent", async () => {
    const shown = await listed([worker()]);

    expect(shown).toMatch(/^wrk_1 .* 0 lease\(s\)$/m);
  });

  it("worker list puts the suffix on the worker's line, before its install lines", async () => {
    const shown = await listed([
      worker({
        capabilities: [{ name: "agent-device", state: "available" }],
        installs: [
          { component: "26.4", platform: "ios", since: 1_000, state: "downloading", waiters: 2 },
        ],
      }),
    ]);

    expect(shown).toContain(
      "-- agent-device available\n  Install ios 26.4: downloading for 0s, 2 waiters",
    );
  });

  it("status against a gateway prints the same suffix in its workers block", async () => {
    const output = outputCapture();
    const status = {
      capacity: {
        android: platform,
        global: { maxRunning: 2, overLimit: false, reserved: 0, running: 0, warm: 0 },
        ios: platform,
      },
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
      devices: [],
      host: { arch: "x64", os: "Linux", osVersion: "6.8.0", tools: [] },
      leases: [],
      queueDepth: 0,
      workers: [
        worker({
          capabilities: [{ name: "agent-device", reason: "starting", state: "unavailable" }],
        }),
      ],
    };
    const environment = output.environmentWith({
      connectAdmin: async () => fakeClient({ getStatus: () => Promise.resolve(status as never) }),
    });

    await runCli(["status"], environment);

    expect(output.stdout).toMatch(/^wrk_1 .* -- agent-device unavailable: starting$/m);
  });
});

describe("simlock worker update", () => {
  type UpdateAnswer = Awaited<ReturnType<SimlockAdminClient["updateWorker"]>>;
  type View = Awaited<ReturnType<SimlockAdminClient["listWorkers"]>>["workers"][number];
  const view = (overrides: Partial<View> = {}): View => ({
    connection: "connected",
    drained: false,
    id: "3f81a2c4",
    label: "mac-studio-2",
    lastSeenAt: 1_000,
    version: "0.3.0",
    ...overrides,
  });
  const run = { forced: false, from: "0.3.0", startedAt: 1_000, to: "0.4.0" } as const;
  const answer = (overrides: Partial<UpdateAnswer> = {}): UpdateAnswer => ({
    health: "running",
    lastUpdateFailure: null,
    latestVersion: "0.4.0",
    resolved: "0.4.0",
    started: true,
    update: { ...run, stage: "installing" },
    upToDate: false,
    version: "0.3.0",
    workerId: "3f81a2c4",
    ...overrides,
  });

  it("follows the update to is running, reports a failure with exit 1, says why the worker is up to date, detaches, and refuses on a worker daemon", async () => {
    const failure = {
      at: 2_000,
      from: "0.3.0",
      message: "npm exited 1",
      stage: "installing",
      to: "0.4.0",
    } as const;
    const cases: readonly {
      readonly name: string;
      readonly argv: readonly string[];
      readonly answer: UpdateAnswer | SimlockError;
      readonly lists?: readonly View[];
      readonly code: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly polls?: number;
    }[] = [
      {
        name: "follows to running",
        argv: ["worker", "update", "3f81a2c4", "--version", "0.4.0", "--force"],
        answer: answer(),
        lists: [
          view({ update: { ...run, leases: 2, stage: "waiting" } }),
          view({ update: { ...run, stage: "installing" } }),
          view({ connection: "disconnected", update: { ...run, stage: "restarting" } }),
          view({ update: { ...run, stage: "restarting" }, version: "0.4.0" }),
          view({ update: null, version: "0.4.0" }),
        ],
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is running 0.4.0\n",
        polls: 5,
      },
      {
        name: "fails with the stage and message",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer(),
        lists: [view({ lastUpdateFailure: failure, update: null })],
        code: 1,
        stdout: "Update failed (installing): npm exited 1\n",
        polls: 1,
      },
      {
        name: "already on the latest",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer({ started: false, update: null, upToDate: true, version: "0.4.0" }),
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is already on the latest (0.4.0)\n",
        polls: 1,
      },
      {
        name: "already running the requested version",
        argv: ["worker", "update", "3f81a2c4", "--version", "0.4.0"],
        answer: answer({ started: false, update: null, upToDate: true, version: "0.4.0" }),
        code: 0,
        stdout: "mac-studio-2 (3f81a2c4) is already running 0.4.0\n",
        polls: 1,
      },
      {
        name: "newer than the latest",
        argv: ["worker", "update", "3f81a2c4"],
        answer: answer({
          resolved: "0.3.0",
          started: false,
          update: null,
          upToDate: true,
          version: "0.4.0",
        }),
        code: 0,
        stdout:
          "mac-studio-2 (3f81a2c4) is newer than the latest (0.3.0). Use --version to install another version.\n",
        polls: 1,
      },
      {
        name: "detach",
        argv: ["worker", "update", "3f81a2c4", "--detach"],
        answer: answer(),
        code: 0,
        stdout:
          "Updating mac-studio-2 (3f81a2c4) 0.3.0 → 0.4.0. Follow it with simlock worker list.\n",
        polls: 1,
      },
      {
        name: "worker daemon",
        argv: ["worker", "update", "3f81a2c4"],
        answer: new SimlockError(
          "UNSUPPORTED_IN_WORKER_MODE",
          "domain",
          "worker.update is a gateway operation",
          { operation: "worker.update" },
        ),
        code: 2,
        stderr: "worker.update is a gateway operation",
        polls: 0,
      },
    ];
    for (const spec of cases) {
      const output = outputCapture();
      const clock = new FakeClock(0);
      const sent: unknown[] = [];
      const lists = [...(spec.lists ?? [view()])];
      let polls = 0;
      const environment = output.environmentWith({
        clock,
        connectAdmin: async () =>
          fakeClient({
            listWorkers: async () => {
              polls += 1;
              const next = lists.length > 1 ? lists.shift() : lists[0];
              return { workers: next === undefined ? [] : [next] };
            },
            updateWorker: async (input) => {
              sent.push(input);
              if (spec.answer instanceof Error) throw spec.answer;
              return spec.answer;
            },
          }),
        // why: a follow that never reaches an outcome fails on this line, not by timing out.
        sleep: async (milliseconds) => {
          if (polls > (spec.lists ?? []).length + 2)
            throw new Error(`${spec.name}: the follow never ended`);
          clock.advance(milliseconds);
        },
      });

      const code = await runCli(spec.argv, environment);

      expect({ code, name: spec.name, stdout: output.stdout }).toEqual({
        code: spec.code,
        name: spec.name,
        stdout: spec.stdout ?? "",
      });
      if (spec.stderr !== undefined) expect(output.stderr).toContain(spec.stderr);
      expect({ name: spec.name, polls }).toEqual({ name: spec.name, polls: spec.polls ?? 0 });
      expect(sent).toEqual([
        {
          workerId: "3f81a2c4",
          ...(spec.argv.includes("--version") ? { version: "0.4.0" } : {}),
          ...(spec.argv.includes("--force") ? { force: true } : {}),
        },
      ]);
    }
  });
});
