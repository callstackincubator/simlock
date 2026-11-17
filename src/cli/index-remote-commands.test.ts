import { describe, expect, it, vi } from "vitest";
import { runCli, type CliEnvironment } from "./index.js";
import {
  EMPTY_STATUS,
  detachedGrant,
  fakeClient,
  outputCapture,
  realCliEnvironmentPorts,
} from "./test-index.js";
import { FakeFarm, type FarmAnswer } from "./test-remote.js";

const URL = "https://farm.example.com";
const AGENT_A = { SIMLOCK_AGENT_ID: "agent-a", SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };

const lease = (id: string, requesterId: string) => ({
  ...detachedGrant.lease,
  id,
  requesterId,
});

const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

const statusOf = (mode: "worker" | "gateway") => ({
  ...EMPTY_STATUS,
  daemon: { ...EMPTY_STATUS.daemon, mode },
});

const farmAnswers: Record<string, FarmAnswer> = {
  "catalog.get": () => ({ platforms: [] }),
  "device.exec": () => ({ exitCode: 0 }),
  "device.rotate": (payload) => payload,
  "doctor.run": () => ({ findings: [], sources: [] }),
  "events.replay": () => [],
  "identity.get": () => ({ name: "ci-runner", principal: "tok_1", role: "agent", via: "token" }),
  "lease.list": () => ({ leases: [] }),
  "lease.release": (payload) => ({ leaseId: (payload as { leaseId: string }).leaseId }),
  "lease.renew": () => detachedGrant.lease,
  "lease.request": () => detachedGrant,
  "list.get": () => [],
  "status.get": () => EMPTY_STATUS,
  "token.list": () => ({ tokens: [] }),
};

interface Options {
  readonly answers?: Record<string, FarmAnswer>;
  readonly env?: NodeJS.ProcessEnv;
  readonly failure?: Error;
  readonly overrides?: Partial<CliEnvironment>;
  readonly role?: "agent" | "admin";
}

async function remote(argv: readonly string[], options: Options = {}) {
  const farm = new FakeFarm({ ...farmAnswers, ...options.answers }, options.role);
  farm.failure = options.failure;
  const output = outputCapture(realCliEnvironmentPorts(), options.env ?? AGENT_A);
  const local = {
    connectAdmin: vi.fn(async () => fakeClient()),
    connectExistingAdmin: vi.fn(async () => fakeClient()),
    readEventHistory: vi.fn(async () => []),
    runPassthrough: vi.fn(async () => 0),
  };
  const environment = output.environmentWith({
    ...local,
    readStdin: async () => "piped",
    webSocket: farm,
    ...options.overrides,
  });
  const code = await runCli(argv, environment);
  const touchedThisMachine = [
    local.connectAdmin,
    local.connectExistingAdmin,
    local.readEventHistory,
    local.runPassthrough,
  ].some((spy) => spy.mock.calls.length > 0);
  return { code, farm, output, touchedThisMachine };
}

const stderrCode = (stderr: string) =>
  (JSON.parse(stderr.trim().split("\n").at(-1) as string) as { error: { code: string } }).error
    .code;

describe("CLI: commands in remote mode", () => {
  it("runs each daemon command on the farm with the token's role, refuses the commands that act on this machine, replays events from the farm, runs simctl and adb as device.exec on the lease of this requester, and notices a lease whose requester is the process", async () => {
    const daemonCommands: [string[], string, string][] = [
      [["status", "--json"], "status.get", "cliVersion"],
      [["lease", "--platform", "ios", "--detach"], "lease.request", "lse_env"],
      [["lease", "renew", "lse_env"], "lease.renew", "lse_env"],
      [["release", "lse_env"], "lease.release", "lse_env"],
      [["list"], "list.get", ""],
      [["catalog"], "catalog.get", ""],
      [["doctor"], "doctor.run", ""],
      [["whoami"], "identity.get", "Via:       token"],
    ];
    for (const [argv, requestType, printed] of daemonCommands) {
      const { code, farm, output, touchedThisMachine } = await remote(argv);
      expect(code, argv.join(" ")).toBe(0);
      expect(farm.requestTypes(), argv.join(" ")).toEqual([requestType]);
      expect(output.stdout, argv.join(" ")).toContain(printed);
      expect(touchedThisMachine, argv.join(" ")).toBe(false);
    }
    const whoami = await remote(["whoami"]);
    expect(whoami.output.stdout).toContain("Name:      ci-runner");

    const forbidden = { "token.list": () => fault("FORBIDDEN", "operator only") };
    const agentTokens = await remote(["token", "list"], { answers: forbidden });
    expect(agentTokens.code).toBe(1);
    expect(stderrCode(agentTokens.output.stderr)).toBe("FORBIDDEN");
    const operatorTokens = await remote(["token", "list"], { role: "admin" });
    expect(operatorTokens.code).toBe(0);
    expect(operatorTokens.farm.requestTypes()).toEqual(["token.list"]);

    const refusals: string[][] = [
      ["daemon", "start"],
      ["daemon", "stop"],
      ["daemon", "status"],
      ["daemon", "logs"],
      ["daemon", "install"],
      ["daemon", "uninstall"],
      ["config", "set", "a", "b"],
      ["setup"],
    ];
    for (const argv of refusals) {
      const { code, farm, output, touchedThisMachine } = await remote(argv);
      const command = argv.length > 1 && argv[0] !== "setup" ? argv.slice(0, 2) : [argv[0]];
      expect(code, argv.join(" ")).toBe(2);
      expect(output.stderr).toContain(
        `\`simlock ${command.join(" ")}\` acts on this machine; it does not run with --url or SIMLOCK_URL. Run it on the daemon's machine, or unset SIMLOCK_URL.`,
      );
      expect(farm.connections, argv.join(" ")).toHaveLength(0);
      expect(touchedThisMachine).toBe(false);
    }

    const events = await remote(["events", "--since", "1h"]);
    expect(events.code).toBe(0);
    expect(events.farm.requestTypes()).toEqual(["events.replay"]);
    expect(events.touchedThisMachine).toBe(false);
    const unreachable = await remote(["events", "--since", "1h"], {
      failure: new Error("connect ECONNREFUSED"),
    });
    expect(unreachable.code).toBe(1);
    expect(stderrCode(unreachable.output.stderr)).toBe("REMOTE_UNREACHABLE");
    expect(unreachable.touchedThisMachine).toBe(false);

    const baseline = {
      imageTag: undefined,
      mode: "full",
      model: "iPhone 17 Pro",
      name: "warm",
      osVersion: "26.5",
      platform: "ios",
      savedAt: "2026-11-17T10:00:00.000Z",
      version: 3,
      workerId: "w1",
    };
    const baselineList = (mode: "worker" | "gateway") => ({
      "baseline.list": () => ({ baselines: [baseline] }),
      "status.get": () => statusOf(mode),
    });
    const gatewayFarm = await remote(["baseline", "list"], { answers: baselineList("gateway") });
    expect(gatewayFarm.output.stdout).toContain("WORKER");
    expect(gatewayFarm.output.stdout).toContain("w1");
    const workerFarm = await remote(["baseline", "list"], {
      answers: baselineList("worker"),
      overrides: {
        daemonHome: { dataDirectory: "/simlock", gatewayPresent: true, role: "gateway" },
      },
    });
    expect(workerFarm.output.stdout).not.toContain("WORKER");
    const unnamed = await remote(["baseline", "remove", "warm"], {
      answers: {
        ...baselineList("gateway"),
        "baseline.remove": () => fault("BAD_REQUEST", "name the worker"),
      },
    });
    expect(unnamed.code).toBe(2);
    expect(stderrCode(unnamed.output.stderr)).toBe("BAD_REQUEST");
    expect(unnamed.farm.requestTypes()).toEqual(["status.get", "baseline.remove"]);
    const confirm = vi.fn(async () => true);
    const named = await remote(["baseline", "remove", "warm"], {
      answers: {
        ...baselineList("worker"),
        "baseline.remove": () => ({ deletedDevices: [], name: "warm", versions: [3] }),
      },
      overrides: {
        confirm,
        daemonHome: { dataDirectory: "/simlock", gatewayPresent: true, role: "gateway" },
      },
    });
    expect(named.code).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(named.farm.requestTypes()).toEqual(["status.get", "baseline.list", "baseline.remove"]);

    const execOf = (farm: FakeFarm) =>
      farm.requests.filter(({ type }) => type === "device.exec").map(({ payload }) => payload);
    const leasesOf = (...held: [string, string][]) => ({
      "lease.list": () => ({ leases: held.map(([id, requester]) => lease(id, requester)) }),
      "status.get": () => statusOf("worker"),
    });
    const simctl = await remote(["simctl", "listapps"], {
      answers: leasesOf(["lse_a", "agent-a"]),
    });
    expect(simctl.code).toBe(0);
    expect(execOf(simctl.farm)).toEqual([
      { args: ["listapps"], leaseId: "lse_a", stdin: "", tool: "simctl" },
    ]);
    expect(simctl.touchedThisMachine).toBe(false);
    const adb = await remote(["adb", "--stdin", "shell", "echo"], {
      answers: leasesOf(["lse_a", "agent-a"]),
    });
    expect(execOf(adb.farm)).toEqual([
      { args: ["shell", "echo"], leaseId: "lse_a", stdin: "piped", tool: "adb" },
    ]);

    const none =
      "No lease is held by agent-a: run `simlock lease` first, or set SIMLOCK_AGENT_ID to the id that holds it";
    const defaults: [string, Parameters<typeof leasesOf>, "agent" | "admin", string][] = [
      ["none", [], "agent", none],
      [
        "two",
        [
          ["lse_a", "agent-a"],
          ["lse_b", "agent-a"],
        ],
        "agent",
        "agent-a holds more than one lease (lse_a, lse_b); pass --lease <id> to name the device you mean",
      ],
      ["another requester's, agent token", [["lse_x", "agent-b"]], "agent", none],
      ["another requester's, operator token", [["lse_x", "agent-b"]], "admin", none],
    ];
    for (const [name, held, role, message] of defaults) {
      for (const argv of [
        ["adb", "shell", "echo"],
        ["rotate", "landscape-left"],
      ]) {
        const refused = await remote(argv, { answers: leasesOf(...held), role });
        expect(refused.code, `${name} ${argv[0]}`).toBe(2);
        expect(refused.output.stderr).toContain(message);
        expect(refused.farm.requestTypes()).toEqual(["lease.list"]);
      }
    }
    const rotated = await remote(["rotate", "landscape-left"], {
      answers: leasesOf(["lse_x", "agent-b"], ["lse_a", "agent-a"]),
    });
    expect(rotated.code).toBe(0);
    expect(rotated.farm.requests.at(-1)).toEqual({
      payload: { leaseId: "lse_a", orientation: "landscape_left" },
      type: "device.rotate",
    });
    const named2 = await remote(["adb", "--lease", "lse_x", "shell", "echo"], {
      answers: leasesOf(["lse_a", "agent-a"]),
    });
    expect(named2.farm.requestTypes()).toEqual(["device.exec"]);
    expect(execOf(named2.farm)).toEqual([
      { args: ["shell", "echo"], leaseId: "lse_x", stdin: "", tool: "adb" },
    ]);

    const noId = { SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };
    const unnamedRequester = await remote(["lease", "--platform", "ios", "--detach"], {
      env: noId,
    });
    const notices = unnamedRequester.output.stderr.split("\n").filter((line) => line !== "");
    expect(notices).toEqual([
      `{"notice":"no SIMLOCK_AGENT_ID or agent session: this lease's requester is ${String(process.pid)}, this process; set SIMLOCK_AGENT_ID, or pass --lease <lease id>, for later commands to find it"}`,
    ]);
    const named3 = await remote(["lease", "--platform", "ios", "--detach"]);
    expect(named3.output.stderr).toBe("");
    const here = outputCapture(realCliEnvironmentPorts(), {});
    const hereCode = await runCli(
      ["lease", "--platform", "ios", "--detach"],
      here.environmentWith({ connectAdmin: vi.fn(async () => fakeClient()) }),
    );
    expect(hereCode).toBe(0);
    expect(here.stderr).not.toContain("no SIMLOCK_AGENT_ID");
  });
});
