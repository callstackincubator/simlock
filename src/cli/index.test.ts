import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import { type Config, CleanupReaper, FakeDriver, LeaseEngine, Registry } from "../core/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem, NodeFilesystem } from "../ports/index.js";
import { DaemonServer } from "../daemon/server.js";
import { connectExistingDaemon } from "./client.js";
import {
  DaemonClientError,
  errorExitCode,
  parseDuration,
  runCli,
  type CliEnvironment,
  type DaemonConnection,
} from "./index.js";
import { JsonRenderer } from "./render.js";

const gibibyte = 1024 ** 3;
const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI boundary", () => {
  it.each([
    ["QUEUE_TIMEOUT", 10],
    ["NO_CAPACITY", 11],
    ["RUNTIME_MISSING", 12],
    ["UNKNOWN_MODEL", 12],
    ["BAD_REQUEST", 2],
  ] as const)("maps %s daemon errors to exit %d", async (code, expected) => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", new DaemonClientError(code, "failed"));

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(expected);
    expect(errorExitCode(new DaemonClientError(code, "failed"))).toBe(expected);
  });

  it("parses human durations and bare milliseconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("250")).toBe(250);
  });

  it("reports missing lease arguments as usage errors", async () => {
    const output = outputCapture();

    await expect(runCli(["lease"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("--platform");
    expect(output.stderr).toContain("USAGE");
  });

  it("rejects an unknown flag with exit 2 and the flag name (strictness parity with parseArgs)", async () => {
    const output = outputCapture();

    await expect(runCli(["status", "--bogus-flag"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("--bogus-flag");
  });

  it("rejects an unknown flag on a nested subcommand", async () => {
    const output = outputCapture();

    await expect(
      runCli(["lease", "renew", "lse_1", "--bogus-flag"], output.environment),
    ).resolves.toBe(2);
    expect(output.stderr).toContain("--bogus-flag");
  });

  it("prints generated usage with flag descriptions on --help for root and lease, exit 0", async () => {
    const root = outputCapture();
    await expect(runCli(["--help"], root.environment)).resolves.toBe(0);
    expect(root.stdout).toContain("lease");
    expect(root.stdout).toContain("Acquire a device");

    const lease = outputCapture();
    await expect(runCli(["lease", "--help"], lease.environment)).resolves.toBe(0);
    expect(lease.stdout).toContain("--platform");
    expect(lease.stdout).toContain("Target platform");
    expect(lease.stdout).toContain("--device");

    const bareLease = outputCapture();
    await expect(runCli(["lease", "-h"], bareLease.environment)).resolves.toBe(0);
    expect(bareLease.stdout).toContain("--platform");
  });

  it("JsonRenderer strips ANSI escapes from any raw text it forwards (help/error/usage)", async () => {
    // citty's own renderUsage colorizes its generated --help text unconditionally unless
    // NO_COLOR/TERM=dumb/CI/TEST is set — it never checks TTY-ness. JsonRenderer is used for every
    // non-interactive/agent invocation (piped, redirected, --json), so it must strip any ANSI color it is
    // handed regardless of source. See docs/CLI.md "Output modes": non-TTY output must never carry color.
    const ansiText =
      "\u001b[4m\u001b[1mUSAGE\u001b[22m\u001b[24m \u001b[36mpitlane [OPTIONS]\u001b[39m";
    let stdout = "";
    let stderr = "";
    const renderer = new JsonRenderer({
      stderr: { write: (value: string) => (stderr += value) },
      stdout: { write: (value: string) => (stdout += value) },
    });

    renderer.info(ansiText);
    renderer.error(ansiText);
    renderer.usage(ansiText);

    // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
    expect(stdout).not.toMatch(/\u001b\[/);
    // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
    expect(stderr).not.toMatch(/\u001b\[/);
    expect(stdout).toContain("USAGE pitlane [OPTIONS]");
    expect(stderr).toContain("USAGE pitlane [OPTIONS]");
  });

  it("prints the generated --help/usage text without ANSI escapes end-to-end (non-interactive)", async () => {
    const root = outputCapture();
    await expect(runCli(["--help"], root.environment)).resolves.toBe(0);
    // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
    expect(root.stdout).not.toMatch(/\u001b\[/);

    const lease = outputCapture();
    await expect(runCli(["lease", "--help"], lease.environment)).resolves.toBe(0);
    // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
    expect(lease.stdout).not.toMatch(/\u001b\[/);

    const usage = outputCapture();
    await expect(runCli(["lease"], usage.environment)).resolves.toBe(2);
    // eslint-disable-next-line no-control-regex -- matching literal ESC () CSI sequences
    expect(usage.stderr).not.toMatch(/\u001b\[/);
  });

  it("routes nested subcommands: lease renew, daemon logs, config set", async () => {
    const renew = outputCapture();
    const renewConnection = new StubConnection();
    renewConnection.response("lease.renew", { id: "lse_1" });
    await expect(
      runCli(
        ["lease", "renew", "lse_1"],
        renew.environmentWith({ connect: async () => renewConnection }),
      ),
    ).resolves.toBe(0);
    expect(renewConnection.calls).toContainEqual({
      payload: { leaseId: "lse_1" },
      type: "lease.renew",
    });

    const logs = outputCapture();
    await expect(
      runCli(["daemon", "logs"], logs.environmentWith({ readLogFile: async () => "a\nb\n" })),
    ).resolves.toBe(0);
    expect(logs.stdout).toBe("a\nb\n");

    const configSet = outputCapture();
    await expect(
      runCli(["config", "set", "limits.maxRunning", "5"], configSet.environment),
    ).resolves.toBe(0);
    expect(JSON.parse(configSet.stdout)).toMatchObject({ key: "limits.maxRunning" });
  });

  it("keeps held lease stdout pure, renders progress to stderr, and releases on SIGTERM", async () => {
    const harness = await createHarness();
    const output = outputCapture();
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        signals,
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    signals.emit("SIGTERM");

    await expect(run).resolves.toBe(0);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toMatchObject({
      device: "iPhone 16",
      os: "26.5",
      platform: "ios",
      state: "leased",
    });
    expect(
      output.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "provisioning" }),
        expect.objectContaining({ event: "booting" }),
      ]),
    );
    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("flagship e2e: queues a second CLI holder until the first connection drops", async () => {
    const harness = await createHarness();
    const first = outputCapture();
    const second = outputCapture();
    const firstSignals = new EventEmitter();
    const secondSignals = new EventEmitter();
    const firstRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      first.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-a",
        signals: firstSignals,
      }),
    );
    await vi.waitFor(() => expect(first.stdout).not.toBe(""));
    const secondRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      second.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-b",
        signals: secondSignals,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.eventBus.replay().some((event) => event.event === "lease.queued")).toBe(true),
    );
    expect(second.stdout).toBe("");
    expect(
      second.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ event: "queued", queue_position: 1 }]);

    firstSignals.emit("SIGTERM");
    await expect(firstRun).resolves.toBe(0);
    await vi.waitFor(() => expect(second.stdout).not.toBe(""));
    secondSignals.emit("SIGTERM");
    await expect(secondRun).resolves.toBe(0);
    expect(
      second.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ event: "queued", queue_position: 1 }]);
  });

  it("prints a detached token, exits, and renews it", async () => {
    const detached = outputCapture();
    const connection = new StubConnection();
    connection.response("lease.request", {
      device: {
        driverDeviceId: "ABCD",
        spec: { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
        state: "leased",
      },
      lease: { id: "lse_9f2c" },
    });

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"],
        detached.environmentWith({ connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(detached.stdout)).toMatchObject({ lease: "lse_9f2c" });
    expect(connection.closed).toBe(true);

    const renew = outputCapture();
    const renewConnection = new StubConnection();
    renewConnection.response("lease.renew", { id: "lse_9f2c", ttlDeadline: 61_000 });
    await expect(
      runCli(
        ["lease", "renew", "lse_9f2c", "--ttl", "1m"],
        renew.environmentWith({ connect: async () => renewConnection }),
      ),
    ).resolves.toBe(0);
    expect(renewConnection.calls).toContainEqual({
      payload: { leaseId: "lse_9f2c", ttlMs: 60_000 },
      type: "lease.renew",
    });
  });

  it("keeps status JSON stable", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", { devices: [], leases: [], revision: 3 });

    await expect(
      runCli(["status", "--json"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toMatchInlineSnapshot(`
      {
        "devices": [],
        "leases": [],
        "revision": 3,
      }
    `);
  });

  it("renders managed and running capacity separately in an interactive terminal", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("status.get", {
      capacity: {
        global: { maxRunning: 3, overLimit: false, reserved: 1, running: 1, warm: 1 },
        ios: {
          limit: 4,
          maxRunning: 2,
          overLimit: false,
          reserved: 1,
          running: 1,
          used: 3,
          warm: 1,
        },
        android: {
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 1,
          warm: 0,
        },
      },
      devices: [],
      leases: [],
    });

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("Capacity global: running 1 + 1 reserved/3, warm 1");
    expect(rendered).toContain("Capacity ios: managed 3/4, running 1 + 1 reserved/2, warm 1");
  });
});

describe("CLI human rendering (interactive terminal)", () => {
  it("renders health and capacity in the interactive status report", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("status.get", {
      capacity: {
        global: { maxRunning: 3, overLimit: false, reserved: 1, running: 1, warm: 1 },
        ios: {
          limit: 4,
          maxRunning: 2,
          overLimit: false,
          reserved: 1,
          running: 1,
          used: 3,
          warm: 1,
        },
        android: {
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 1,
          warm: 0,
        },
      },
      devices: [{ id: "dev_1", state: "ready" }],
      leases: [{ grantedAt: 1_000, id: "lse_1", requesterId: "agent-a" }],
      queueDepth: 2,
    });

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("Daemon: running");
    expect(rendered).toContain("Capacity ios: managed 3/4");
    expect(rendered).toContain("Capacity android: managed 1/2");
    expect(rendered).toContain("dev_1");
    expect(rendered).toContain("lse_1");
    expect(rendered).toContain("Queue depth: 2");
  });

  it("renders an interactive lease flow: intro, details, holding line, outro on release", async () => {
    const harness = await createHarness();
    const output = outputCapture({ interactive: true });
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        signals,
      }),
    );

    await vi.waitFor(() => expect(stripAnsi(output.stdout)).toContain("iPhone 16"));
    const stderrAtGrant = stripAnsi(output.stderr);
    expect(stderrAtGrant).toContain("pitlane");
    expect(stderrAtGrant).toContain("Holding lease");
    expect(stripAnsi(output.stdout)).toContain("26.5");

    signals.emit("SIGTERM");
    await expect(run).resolves.toBe(0);
    expect(stripAnsi(output.stderr)).toContain("Lease released");
    await expect.poll(() => harness.registry.snapshot.leases).toHaveLength(0);
  });

  it("shows queue position while a second interactive holder waits", async () => {
    const harness = await createHarness();
    const first = outputCapture();
    const second = outputCapture({ interactive: true });
    const firstSignals = new EventEmitter();
    const secondSignals = new EventEmitter();
    const firstRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      first.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-a",
        signals: firstSignals,
      }),
    );
    await vi.waitFor(() => expect(first.stdout).not.toBe(""));
    const secondRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      second.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-b",
        signals: secondSignals,
      }),
    );
    await vi.waitFor(() =>
      expect(stripAnsi(second.stderr)).toContain("Waiting in queue (position 1)"),
    );

    firstSignals.emit("SIGTERM");
    await expect(firstRun).resolves.toBe(0);
    await vi.waitFor(() => expect(stripAnsi(second.stdout)).toContain("iPhone 16"));
    secondSignals.emit("SIGTERM");
    await expect(secondRun).resolves.toBe(0);
  });

  it("renders an aligned, colored device table for list --devices", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("list.get", [
      {
        id: "dev_1",
        spec: { model: "iPhone 16", osVersion: "18.0", platform: "ios" },
        state: "ready",
      },
      {
        id: "dev_2",
        spec: { model: "Pixel 8", osVersion: "15", platform: "android" },
        state: "booting",
      },
    ]);

    await expect(
      runCli(["list", "--devices"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("ID");
    expect(rendered).toContain("dev_1");
    expect(rendered).toContain("iPhone 16");
    expect(rendered).toContain("ready");
    expect(rendered).toContain("dev_2");
    expect(rendered).toContain("booting");
  });

  it("renders a dim placeholder line for an empty list", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("list.get", []);

    await expect(
      runCli(["list", "--leases"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(stripAnsi(output.stdout).trim()).toBe("No leases");
  });

  it("renders leases with a human-relative granted time", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("list.get", [
      {
        deviceId: "dev_1",
        grantedAt: Date.now() - 3 * 60_000,
        id: "lse_1",
        requesterId: "agent-a",
      },
    ]);

    await expect(
      runCli(["list", "--leases"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("lse_1");
    expect(rendered).toContain("agent-a");
    expect(rendered).toMatch(/3m ago/);
  });

  it("renders planned cleanup actions with arrows on --dry-run", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("cleanup.run", [
      { action: "shutdown", reason: "idle 10m", rule: "idle-shutdown", target: "dev_1" },
    ]);

    await expect(
      runCli(["cleanup", "--dry-run"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("→ idle-shutdown: shutdown dev_1 (idle 10m)");
  });

  it("renders performed cleanup actions with checkmarks and a summary", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("cleanup.run", [
      { action: "shutdown", reason: "idle 10m", rule: "idle-shutdown", target: "dev_1" },
    ]);

    await expect(
      runCli(["cleanup"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("✓ idle-shutdown: shutdown dev_1 (idle 10m)");
    expect(rendered).toContain("1 action, 0 failures");
  });

  it("renders 'Nothing to clean up' when there are no proposals", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("cleanup.run", []);

    await expect(
      runCli(["cleanup"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(stripAnsi(output.stdout).trim()).toBe("Nothing to clean up");
  });

  it("renders doctor findings with colored glyphs and a summary", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("doctor.run", {
      findings: [
        { deviceId: "dev_1", kind: "registry-device-missing", platform: "ios" },
        { device: { deviceId: "dev_2" }, kind: "orphan-process", platform: "android" },
      ],
    });

    await expect(
      runCli(["doctor"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("✗ Registry device dev_1");
    expect(rendered).toContain("! Orphan android process for device dev_2");
    expect(rendered).toContain("2 findings");
  });

  it("renders doctor findings as fixed when --fix is passed", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("doctor.run", {
      findings: [{ deviceId: "dev_1", kind: "registry-device-missing", platform: "ios" }],
    });

    await expect(
      runCli(["doctor", "--fix"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("✓ Registry device dev_1");
    expect(rendered).toContain("1 finding, 1 fixed");
  });

  it("renders 'No issues found' when doctor finds nothing", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("doctor.run", { findings: [] });

    await expect(
      runCli(["doctor"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(stripAnsi(output.stdout)).toContain("No issues found");
  });

  it("renders a red warning and proceeds after an interactive nuke is confirmed", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("nuke.run", { deletedDevices: [], releasedLeaseIds: ["lse_1", "lse_2"] });
    const confirm = vi.fn().mockResolvedValue(true);

    await expect(
      runCli(["nuke"], output.environmentWith({ confirm, connect: async () => connection })),
    ).resolves.toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain("force-release every active lease");
    expect(stripAnsi(output.stdout)).toContain("Released 2 leases");
  });

  it("exits like the unconfirmed path when an interactive nuke is declined or cancelled", async () => {
    const output = outputCapture({ interactive: true });
    const confirm = vi.fn().mockResolvedValue(false);

    await expect(runCli(["nuke"], output.environmentWith({ confirm }))).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(stripAnsi(output.stderr)).toContain("nuke requires confirmation or --yes");
  });

  it("skips the confirm prompt entirely when --yes is passed", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("nuke.run", { deletedDevices: [], releasedLeaseIds: [] });
    const confirm = vi.fn().mockResolvedValue(false);

    await expect(
      runCli(
        ["nuke", "--yes"],
        output.environmentWith({ confirm, connect: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("renders each event with a dim time, colored name, and payload summary", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("events.replay", [
      {
        event: "lease.granted",
        module: "daemon",
        payload: { deviceId: "dev_1", leaseId: "lse_1" },
        seq: 1,
        timestamp: Date.now(),
      },
    ]);

    await expect(
      runCli(["events"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("lease.granted");
    expect(rendered).toContain("leaseId=lse_1");
  });

  it("renders colored daemon state words for start/stop/status", async () => {
    const running = outputCapture({ interactive: true });
    const startConnection = new StubConnection();
    await expect(
      runCli(
        ["daemon", "start"],
        running.environmentWith({ connect: async () => startConnection }),
      ),
    ).resolves.toBe(0);
    expect(stripAnsi(running.stdout)).toContain("Daemon ● running");

    const stopping = outputCapture({ interactive: true });
    const stopConnection = new StubConnection();
    await expect(
      runCli(
        ["daemon", "stop"],
        stopping.environmentWith({ connectExisting: async () => stopConnection }),
      ),
    ).resolves.toBe(0);
    expect(stripAnsi(stopping.stdout)).toContain("Daemon ● stopping");

    const stopped = outputCapture({ interactive: true });
    await expect(
      runCli(
        ["daemon", "status"],
        stopped.environmentWith({
          connectExisting: async () => {
            throw new Error("daemon not running");
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(stripAnsi(stopped.stdout)).toContain("Daemon ● stopped");
  });

  it("renders the effective configuration as an indented, dim-keyed tree", async () => {
    const output = outputCapture({ interactive: true });
    const connection = new StubConnection();
    connection.response("config.get", {
      lease: { detachedTtlMs: 60_000 },
      limits: { maxRunning: 2 },
    });

    await expect(
      runCli(["config"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("lease:");
    expect(rendered).toContain("detachedTtlMs:");
    expect(rendered).toContain("60000");
  });

  it("renders a confirmation line with the new value and restart note for config set", async () => {
    const output = outputCapture({ interactive: true });

    await expect(
      runCli(["config", "set", "lease.detachedTtlMs", "90000"], output.environmentWith({})),
    ).resolves.toBe(0);
    const rendered = stripAnsi(output.stdout);
    expect(rendered).toContain("lease.detachedTtlMs = 90000");
    expect(rendered).toContain("takes effect on next daemon restart");
  });
});

describe("CLI JSON agent contract (pinned exact bytes)", () => {
  it("prints the held-mode lease result as a single JSON line, byte for byte", async () => {
    const harness = await createHarness();
    const output = outputCapture();
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        signals,
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    const stdoutAtGrant = output.stdout;
    signals.emit("SIGTERM");
    await expect(run).resolves.toBe(0);

    expect(stdoutAtGrant.endsWith("\n")).toBe(true);
    expect(stdoutAtGrant.trim().split("\n")).toHaveLength(1);
    const parsed: unknown = JSON.parse(stdoutAtGrant);
    expect(parsed).toEqual({
      device: "iPhone 16",
      lease: expect.any(String),
      os: "26.5",
      platform: "ios",
      state: "leased",
      udid: expect.any(String),
    });
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual(
      ["device", "lease", "os", "platform", "state", "udid"].sort(),
    );
  });

  it("emits queued progress with exactly {event, queue_position}", async () => {
    const harness = await createHarness();
    const first = outputCapture();
    const second = outputCapture();
    const firstSignals = new EventEmitter();
    const secondSignals = new EventEmitter();
    const firstRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      first.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-a",
        signals: firstSignals,
      }),
    );
    await vi.waitFor(() => expect(first.stdout).not.toBe(""));
    const secondRun = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      second.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        requesterId: "agent-b",
        signals: secondSignals,
      }),
    );
    await vi.waitFor(() => expect(second.stderr).not.toBe(""));

    expect(second.stderr).toBe('{"event":"queued","queue_position":1}\n');

    firstSignals.emit("SIGTERM");
    await expect(firstRun).resolves.toBe(0);
    await vi.waitFor(() => expect(second.stdout).not.toBe(""));
    secondSignals.emit("SIGTERM");
    await expect(secondRun).resolves.toBe(0);
  });

  it("emits provisioning/booting progress with exactly {event, eta_seconds}", async () => {
    const harness = await createHarness();
    const output = outputCapture();
    const signals = new EventEmitter();
    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 16"],
      output.environmentWith({
        connect: () => connectExistingDaemon(harness.socketPath),
        signals,
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    const progressLines = output.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of progressLines) {
      expect(Object.keys(line).sort()).toEqual(["event", "eta_seconds"].sort());
      expect(typeof line.eta_seconds).toBe("number");
    }
    expect(progressLines.map((line) => line.event)).toEqual(
      expect.arrayContaining(["provisioning", "booting"]),
    );

    signals.emit("SIGTERM");
    await expect(run).resolves.toBe(0);
  });

  it("pins status --json to the raw daemon payload, verbatim", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("status.get", { devices: [], leases: [], revision: 3 });

    await expect(
      runCli(["status", "--json"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);

    expect(output.stdout).toBe('{"devices":[],"leases":[],"revision":3}\n');
  });

  it("pins non-interactive status (no --json) to raw JSON, same as --json (contract change)", async () => {
    const output = outputCapture();
    const statusPayload = {
      capacity: {
        global: { maxRunning: 3, overLimit: false, reserved: 1, running: 1, warm: 1 },
        ios: {
          limit: 4,
          maxRunning: 2,
          overLimit: false,
          reserved: 1,
          running: 1,
          used: 3,
          warm: 1,
        },
        android: {
          limit: 2,
          maxRunning: 2,
          overLimit: false,
          reserved: 0,
          running: 0,
          used: 1,
          warm: 0,
        },
      },
      devices: [{ id: "dev_1", state: "ready" }],
      leases: [{ grantedAt: 1_000, id: "lse_1", requesterId: "agent-a" }],
      queueDepth: 2,
    };
    const connection = new StubConnection();
    connection.response("status.get", statusPayload);

    await expect(
      runCli(["status"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);

    expect(output.stdout).toBe(`${JSON.stringify(statusPayload)}\n`);
  });

  it("pins the error-case exit code and stderr for an unknown command", async () => {
    const output = outputCapture();

    await expect(runCli(["bogus"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("Unknown command: bogus\n");
    expect(output.stderr).toContain("USAGE");
  });

  it("pins release --all without confirmation as a usage error, exit 2", async () => {
    const output = outputCapture();

    await expect(runCli(["release", "--all"], output.environment)).resolves.toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("release --all requires confirmation or --yes\n");
    expect(output.stderr).toContain("USAGE");
  });

  it("pins list --devices to the raw daemon array, verbatim", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const devices = [
      {
        id: "dev_1",
        spec: { model: "iPhone 16", osVersion: "18.0", platform: "ios" },
        state: "ready",
      },
    ];
    connection.response("list.get", devices);

    await expect(
      runCli(["list", "--devices"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(devices)}\n`);
  });

  it("pins cleanup --dry-run to the raw proposal array, verbatim", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const proposals = [
      { action: "shutdown", reason: "idle 10m", rule: "idle-shutdown", target: "dev_1" },
    ];
    connection.response("cleanup.run", proposals);

    await expect(
      runCli(["cleanup", "--dry-run"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(proposals)}\n`);
  });

  it("pins doctor.run to the raw report object, verbatim", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const report = {
      findings: [{ deviceId: "dev_1", kind: "registry-device-missing", platform: "ios" }],
    };
    connection.response("doctor.run", report);

    await expect(
      runCli(["doctor"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(report)}\n`);
  });

  it("pins nuke.run to the raw result object, verbatim", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const result = { deletedDevices: [], releasedLeaseIds: ["lse_1"] };
    connection.response("nuke.run", result);

    await expect(
      runCli(["nuke", "--yes"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(result)}\n`);
  });

  it("pins events replay to raw JSON lines, one event per line", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const event = {
      event: "lease.granted",
      module: "daemon",
      payload: { deviceId: "dev_1", leaseId: "lse_1" },
      seq: 1,
      timestamp: 1_000,
    };
    connection.response("events.replay", [event]);

    await expect(
      runCli(["events"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(event)}\n`);
  });

  it("pins daemon start/stop/status/logs to their existing raw payloads", async () => {
    const start = outputCapture();
    const startConnection = new StubConnection();
    await expect(
      runCli(["daemon", "start"], start.environmentWith({ connect: async () => startConnection })),
    ).resolves.toBe(0);
    expect(start.stdout).toBe('{"status":"running"}\n');

    const stop = outputCapture();
    const stopConnection = new StubConnection();
    await expect(
      runCli(
        ["daemon", "stop"],
        stop.environmentWith({ connectExisting: async () => stopConnection }),
      ),
    ).resolves.toBe(0);
    expect(stop.stdout).toBe('{"status":"stopping"}\n');

    const status = outputCapture();
    await expect(
      runCli(
        ["daemon", "status"],
        status.environmentWith({
          connectExisting: async () => {
            throw new Error("daemon not running");
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(status.stdout).toBe('{"status":"stopped"}\n');

    const logs = outputCapture();
    await expect(
      runCli(
        ["daemon", "logs"],
        logs.environmentWith({ readLogFile: async () => "line one\nline two\n" }),
      ),
    ).resolves.toBe(0);
    expect(logs.stdout).toBe("line one\nline two\n");
  });

  it("pins a running daemon status to the raw status.get payload, not a {status} wrapper", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    const daemonStatus = { devices: [], health: "running", leases: [] };
    connection.response("status.get", daemonStatus);

    await expect(
      runCli(
        ["daemon", "status"],
        output.environmentWith({ connectExisting: async () => connection }),
      ),
    ).resolves.toBe(0);
    expect(output.stdout).toBe(`${JSON.stringify(daemonStatus)}\n`);
  });

  it("pins config get/set to their existing raw payloads", async () => {
    const output = outputCapture();
    const connection = new StubConnection();
    connection.response("config.get", { lease: { detachedTtlMs: 60_000 } });

    await expect(
      runCli(["config"], output.environmentWith({ connect: async () => connection })),
    ).resolves.toBe(0);
    expect(output.stdout).toBe('{"lease":{"detachedTtlMs":60000}}\n');

    const setOutput = outputCapture();
    await expect(
      runCli(["config", "set", "lease.detachedTtlMs", "90000"], setOutput.environment),
    ).resolves.toBe(0);
    expect(JSON.parse(setOutput.stdout)).toEqual({
      configPath: "/config.json",
      effectiveAt: "next daemon restart",
      key: "lease.detachedTtlMs",
      updated: true,
    });
  });
});

class StubConnection implements DaemonConnection {
  readonly calls: Array<{ readonly payload: unknown; readonly type: string }> = [];
  closed = false;
  readonly #listeners = new Set<(kind: string, payload: unknown) => void>();
  readonly #responses = new Map<string, unknown>();

  response(type: string, value: unknown): void {
    this.#responses.set(type, value);
  }

  async request(type: string, payload: unknown): Promise<unknown> {
    this.calls.push({ payload, type });
    const value = this.#responses.get(type);
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }

  onPush(listener: (kind: string, payload: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  push(kind: string, payload: unknown): void {
    for (const listener of this.#listeners) {
      listener(kind, payload);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "pitlane-cli-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "daemon.sock");
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem: new MemoryFilesystem(),
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
  const config = testConfig();
  const engine = new LeaseEngine({
    clock,
    config,
    drivers: [driver],
    eventBus,
    idGenerator: sequence(),
    registry,
    systemStats: new FakeSystemStats({
      cpuCount: 8,
      freeRamBytes: 32 * gibibyte,
      totalRamBytes: 32 * gibibyte,
    }),
  });
  const daemon = new DaemonServer({
    config,
    defaultRequesterId: "test-process",
    eventBus,
    filesystem: new NodeFilesystem(),
    leaseEngine: engine,
    reaper: new CleanupReaper({
      clock,
      config,
      eventBus,
      filesystem: new MemoryFilesystem(),
      leaseEngine: engine,
      registry,
    }),
    registry,
    socketPath,
    version: "test",
  });
  runningDaemons.push(daemon);
  await daemon.start();
  return { eventBus, registry, socketPath };
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(): Config {
  return {
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { detachedTtlMs: 60_000, heldTtlBackstopMs: 60_000 },
    limits: {
      android: { maxDevices: 1, maxRunning: 1 },
      ios: { maxDevices: 1, maxRunning: 1 },
      maxRunning: 1 + 1,
    },
    ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
  };
}

function outputCapture(options: { readonly interactive?: boolean } = {}) {
  let stderr = "";
  let stdout = "";
  const environment: CliEnvironment = {
    connect: async () => {
      throw new Error("Unexpected daemon connection");
    },
    configPath: "/config.json",
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
    readConfigFile: async () => ({}),
    requesterId: "test-requester",
    signals: new EventEmitter(),
    stderr: { write: (value: string) => (stderr += value) },
    stdout: { write: (value: string) => (stdout += value) },
    writeConfigFile: async () => undefined,
  };
  return {
    environment,
    environmentWith(overrides: Partial<CliEnvironment>): CliEnvironment {
      return { ...environment, ...overrides };
    },
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}

/** Strips ANSI escape sequences (SGR colors, cursor movement) for assertions on human-mode output. */
function stripAnsi(value: string): string {
  const pattern = new RegExp(
    `[\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))`,
    "g",
  );
  return value.replace(pattern, "");
}
