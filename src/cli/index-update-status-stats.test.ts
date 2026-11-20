import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { fromWireError, SimlockError } from "../contract/index.js";
import type { SimlockAdminClient } from "../simlock-client/client.js";
import { runCli, type CliEnvironment } from "./index.js";
import {
  PACKAGE_VERSION,
  fakeClient,
  outputCapture,
  statusLines,
  usageAnswer,
} from "./test-index.js";

describe("simlock update and simlock status", () => {
  type UpdateAnswer = Awaited<ReturnType<SimlockAdminClient["updateDaemon"]>>;
  type Step = UpdateAnswer | SimlockError;
  const lost = () =>
    new SimlockError("DAEMON_CONNECTION_LOST", "transport", "The daemon connection was lost", {});
  const answer = (overrides: Partial<UpdateAnswer> = {}): UpdateAnswer => ({
    started: false,
    upToDate: false,
    resolved: null,
    version: "0.3.0",
    health: "running",
    update: null,
    lastUpdateFailure: null,
    latestVersion: null,
    ...overrides,
  });
  const state = (
    stage: "waiting" | "installing" | "restarting",
    leases = 0,
  ): NonNullable<UpdateAnswer["update"]> => {
    const base = { from: "0.3.0", to: "0.4.0", forced: false, startedAt: 1_000 };
    return stage === "waiting" ? { stage, leases, ...base } : { stage, ...base };
  };
  const failure = (stage: "installing" | "restarting", message: string) => ({
    stage,
    from: "0.3.0",
    to: "0.4.0",
    message,
    at: 2_000,
  });
  const started = (update = state("installing")) =>
    answer({ started: true, resolved: "0.4.0", update });
  const running = (version = "0.4.0", overrides: Partial<UpdateAnswer> = {}) =>
    answer({ version, ...overrides });

  async function runUpdate(
    argv: readonly string[],
    script: {
      readonly first: UpdateAnswer | SimlockError;
      readonly polls?: readonly Step[];
      readonly after?: readonly (Step | Error)[];
      readonly onPoll?: (index: number, interrupt: () => void) => void;
      readonly onReconnect?: (interrupt: () => void) => void;
    },
  ) {
    const output = outputCapture();
    const clock = new FakeClock(0);
    const calls: unknown[] = [];
    const polls = [...(script.polls ?? [])];
    const after = [...(script.after ?? [])];
    let pollCount = 0;
    const signals = new EventEmitter();
    let opened = 0;
    const closedClients = new Set<number>();
    const clientOver = (steps: Step[], first?: UpdateAnswer | SimlockError) => {
      const id = opened++;
      return fakeClient({
        close: async () => {
          closedClients.add(id);
        },
        updateDaemon: async (input) => {
          calls.push(input);
          const isFirst = first !== undefined && calls.length === 1;
          if (!isFirst) script.onPoll?.(pollCount++, () => signals.emit("SIGINT"));
          const step = isFirst ? first : steps.length > 1 ? steps.shift() : steps[0];
          if (step === undefined) throw new Error("no scripted answer");
          if (step instanceof Error) throw step;
          return step;
        },
      });
    };
    const environment = output.environmentWith({
      clock,
      connectAdmin: async () => clientOver(polls, script.first),
      connectExistingAdmin: async () => {
        script.onReconnect?.(() => signals.emit("SIGINT"));
        const step = after.length > 1 ? after.shift() : after[0];
        if (step === undefined || step instanceof Error) throw step ?? new Error("refused");
        return clientOver([step]);
      },
      sleep: async (milliseconds) => clock.advance(milliseconds),
      signals: signals as unknown as CliEnvironment["signals"],
    });
    const code = await runCli(argv, environment);
    return {
      code,
      calls,
      stdout: output.stdout,
      stderr: output.stderr,
      opened,
      closed: closedClients.size,
    };
  }

  it("follows an update to simlock <v> is running, reports a failure and a rollback, says when nothing is needed, stops following on Ctrl-C only, prints --json, refuses bad input, and shows the version, the update and the last failure in simlock status", async () => {
    let reconnects = 0;
    // why: the follower reconnects every second and gives up when 15 minutes have passed since the last answer, so the last attempt is at 14:59 on the fake clock.
    const RECONNECTS_IN_15_MINUTES = 899;
    const header = "Updating simlock 0.3.0 → 0.4.0\n";
    const wait =
      "Waiting for 2 leases to end. Ctrl-C stops following; simlock update --force stops waiting.\n";
    const cases: readonly {
      readonly name: string;
      readonly argv: readonly string[];
      readonly script: Parameters<typeof runUpdate>[1];
      readonly code: number;
      readonly stdout: string;
      readonly calls?: readonly unknown[];
      readonly reconnects?: number;
    }[] = [
      {
        name: "follows to running",
        argv: ["update"],
        script: {
          first: started(state("waiting", 2)),
          polls: [
            answer({ update: state("waiting", 2) }),
            answer({ update: state("waiting", 1) }),
            answer({ update: state("installing") }),
            answer({ update: state("restarting") }),
            lost(),
          ],
          after: [new Error("refused"), running()],
        },
        code: 0,
        stdout: `${header}${wait}Waiting for 1 lease to end.\nInstalling simlock@0.4.0\nRestarting the daemon\nsimlock 0.4.0 is running\n`,
        calls: [{}, ...Array.from({ length: 6 }, () => ({ query: true }))],
      },
      {
        name: "follows an update that already runs, whatever version it names",
        argv: ["update", "--version", "0.9.9"],
        script: {
          first: answer({ update: state("installing") }),
          polls: [lost()],
          after: [running()],
        },
        code: 0,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nsimlock 0.4.0 is running\n`,
      },
      {
        name: "reports a failed install",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ lastUpdateFailure: failure("installing", "npm error code EACCES") })],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nUpdate failed (installing): npm error code EACCES\nsimlock 0.3.0 is still running and takes leases again.\n`,
      },
      {
        name: "reports a version that did not start and the rollback",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ update: state("restarting") }), lost()],
          after: [
            answer({
              lastUpdateFailure: failure("restarting", "0.4.0 did not start: health failed"),
            }),
          ],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nUpdate failed (restarting): 0.4.0 did not start: health failed. Rolled back to 0.3.0.\n`,
      },
      {
        name: "waits through a daemon that answers while it is still starting",
        argv: ["update"],
        script: {
          first: started(),
          polls: [lost()],
          after: [
            answer({ health: "starting" }),
            answer({ health: "starting" }),
            answer({ health: "starting" }),
            answer({
              lastUpdateFailure: failure("restarting", "0.4.0 did not start: health failed"),
            }),
          ],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nUpdate failed (restarting): 0.4.0 did not start: health failed. Rolled back to 0.3.0.\n`,
      },
      {
        name: "gives up when the daemon does not come back in 15 minutes",
        argv: ["update"],
        script: {
          first: started(),
          polls: [answer({ update: state("restarting") }), lost()],
          after: [new Error("refused")],
          onReconnect: () => {
            reconnects += 1;
          },
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nThe daemon did not come back; run simlock status.\n`,
        reconnects: RECONNECTS_IN_15_MINUTES,
      },
      {
        name: "stops with the daemon's own error when a poll is refused for a reason other than a lost connection",
        argv: ["update"],
        script: {
          first: started(),
          polls: [new SimlockError("UPDATE_RESOLVE_FAILED", "domain", "npm is down", {})],
        },
        code: 1,
        stdout: `${header}Installing simlock@0.4.0\n`,
      },
      {
        name: "prints its usage for --help and asks the daemon nothing",
        argv: ["update", "--help"],
        script: { first: answer() },
        code: 0,
        stdout: "Usage: simlock update [--version <version>] [--force] [--json]\n",
        calls: [],
      },
      {
        name: "the latest version is the running one",
        argv: ["update"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already the latest\n",
        calls: [{}],
      },
      {
        name: "the named version is the running one",
        argv: ["update", "--version", "0.3.0"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already running\n",
        calls: [{ version: "0.3.0" }],
      },
      {
        name: "the running version is newer than the latest",
        argv: ["update"],
        script: { first: answer({ upToDate: true, resolved: "0.4.0", version: "0.5.0-rc.1" }) },
        code: 0,
        stdout:
          "simlock 0.5.0-rc.1 is newer than the latest (0.4.0). Use --version to install another version.\n",
      },
      {
        name: "sends force and the version",
        argv: ["update", "--force", "--version", "0.4.0-rc.1"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: "simlock 0.3.0 is already running\n",
        calls: [{ force: true, version: "0.4.0-rc.1" }],
      },
      {
        name: "--json prints the final answer only",
        argv: ["update", "--json"],
        script: { first: started(state("waiting", 1)), polls: [lost()], after: [running()] },
        code: 0,
        stdout: `${JSON.stringify(running())}\n`,
      },
      {
        name: "--json with nothing to do prints the answer at once",
        argv: ["update", "--json"],
        script: { first: answer({ upToDate: true, resolved: "0.3.0" }) },
        code: 0,
        stdout: `${JSON.stringify(answer({ upToDate: true, resolved: "0.3.0" }))}\n`,
        calls: [{}],
      },
      {
        name: "Ctrl-C stops following and sends nothing more",
        argv: ["update"],
        script: {
          first: started(state("waiting", 2)),
          polls: [answer({ update: state("waiting", 2) })],
          onPoll: (_index, interrupt) => interrupt(),
        },
        code: 0,
        stdout: `${header}${wait}Stopped following. The update goes on; run simlock status to see it.\n`,
        calls: [{}, { query: true }],
      },
      {
        name: "Ctrl-C while the daemon restarts stops following",
        argv: ["update"],
        script: {
          first: started(),
          polls: [lost()],
          after: [new Error("refused")],
          onReconnect: (interrupt) => interrupt(),
        },
        code: 0,
        stdout: `${header}Installing simlock@0.4.0\nRestarting the daemon\nStopped following. The update goes on; run simlock status to see it.\n`,
        calls: [{}, { query: true }],
      },
    ];
    for (const { name, argv, script, code, stdout, calls, reconnects: expected } of cases) {
      reconnects = 0;
      const result = await runUpdate(argv, script);
      if (expected !== undefined) expect(reconnects, name).toBe(expected);
      expect({ name, code: result.code, stdout: result.stdout }, name).toEqual({
        name,
        code,
        stdout,
      });
      if (calls !== undefined) expect(result.calls, name).toEqual(calls);
      expect(result.closed, `${name}: every client opened is closed`).toBe(result.opened);
    }

    const refusals: readonly [readonly string[], number, string][] = [
      [["update", "--version", "latest"], 2, "--version takes a version, e.g. 0.4.0"],
      [["update", "--version", "../x"], 2, "--version takes a version, e.g. 0.4.0"],
      [["update", "--version", `1.0.0-${"a".repeat(59)}`], 2, "--version takes a version"],
    ];
    for (const [argv, code, message] of refusals) {
      const result = await runUpdate(argv, { first: answer() });
      expect({ argv, code, stderr: result.stderr.includes(message), calls: result.calls }).toEqual({
        argv,
        code,
        stderr: true,
        calls: [],
      });
    }

    const refused = [
      ["UPDATE_RESOLVE_FAILED", 1, "could not resolve simlock@9.9.9: No match found"],
      ["UPDATE_UNSUPPORTED_INSTALL", 2, "simlock was not installed with npm i -g"],
    ] as const;
    for (const [codeName, exit, message] of refused) {
      const result = await runUpdate(["update"], {
        first: new SimlockError(codeName, "domain", message, {}),
      });
      expect({ code: result.code, stdout: result.stdout }).toEqual({ code: exit, stdout: "" });
      expect(JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: codeName, message },
      });
    }

    const next = "Host: macOS 15.5 arm64";
    expect(await statusLines({ version: "0.3.0" })).toEqual([
      "Daemon: running (worker)",
      "Simlock: 0.3.0",
      `CLI: ${PACKAGE_VERSION}`,
      next,
      expect.stringMatching(/^Running global/),
    ]);
    for (const [update, line] of [
      [state("waiting", 2), "Updating to 0.4.0: waiting for 2 leases"],
      [state("waiting", 1), "Updating to 0.4.0: waiting for 1 lease"],
      [state("installing"), "Updating to 0.4.0: installing"],
      [state("restarting"), "Updating to 0.4.0: restarting"],
    ] as const) {
      expect((await statusLines({ version: "0.3.0", update })).slice(0, 4)).toEqual([
        "Daemon: running (worker)",
        "Simlock: 0.3.0",
        `CLI: ${PACKAGE_VERSION}`,
        line,
      ]);
    }
    expect(
      (
        await statusLines({
          version: "0.3.0",
          lastUpdateFailure: failure("installing", "npm error code EACCES"),
        })
      ).slice(0, 4),
    ).toEqual([
      "Daemon: running (worker)",
      "Simlock: 0.3.0",
      `CLI: ${PACKAGE_VERSION}`,
      "Last update failed (installing): npm error code EACCES",
    ]);
  });

  it("simlock status says when the daemon has seen a newer Simlock version on npm", async () => {
    for (const [version, latestVersion, line] of [
      ["0.3.0", "0.4.0", "Simlock: 0.3.0 (0.4.0 available)"],
      ["0.9.0", "0.10.0", "Simlock: 0.9.0 (0.10.0 available)"],
      ["0.4.0-rc.2", "0.4.0", "Simlock: 0.4.0-rc.2 (0.4.0 available)"],
      ["0.4.0", "0.4.0", "Simlock: 0.4.0"],
      ["0.5.0-rc.1", "0.4.0", "Simlock: 0.5.0-rc.1"],
      ["0.3.0", null, "Simlock: 0.3.0"],
    ] as const) {
      expect((await statusLines({ version, latestVersion }))[1]).toBe(line);
    }
  });
});

describe("CLI: stats", () => {
  const NOW = Date.parse("2026-10-05T12:00:00.000Z");
  const HOUR = 3_600_000;

  function statsRun(argv: readonly string[], usage: SimlockAdminClient["usage"]) {
    const output = outputCapture();
    const asked: { from: number; to: number; includeLedger?: boolean | undefined }[] = [];
    const run = runCli(
      ["stats", ...argv],
      output.environmentWith({
        adminTokenFromEnv: "admin-token",
        clock: new FakeClock(NOW),
        connectAdmin: async (resolveCredential) => {
          await resolveCredential();
          return fakeClient({
            usage: async (window) => {
              asked.push(window);
              return usage(window);
            },
          });
        },
      }),
    );
    return { asked, output, run };
  }

  it("simlock stats words each refusal as the Inputs table says, exits 2, and asks nothing of the daemon", async () => {
    for (const argv of [["--since", "1h"], ["--from", "2026-10-05T10:00:00Z"], ["--json"]]) {
      const { output, run } = statsRun(argv, async (window) => usageAnswer(window));
      await expect(run, argv.join(" ")).resolves.toBe(0);
      expect(output.stderr, argv.join(" ")).not.toContain("USAGE");
    }
    for (const [argv, message] of [
      [
        ["--since", "1h", "--from", "2026-10-05T10:00:00Z"],
        "stats takes --since or --from, not both",
      ],
      [["--to", "2026-10-04T10:00:00Z"], "--to needs --from"],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-03T10:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-04T10:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [
        ["--from", "2026-10-05T13:00:00Z"],
        "--from must be earlier than --to, or than now when --to is left out",
      ],
      [["--since", "soon"], "Invalid duration: soon"],
      [["--from", "2026-10-15"], "Invalid time: 2026-10-15 (use ISO 8601 with Z or an offset)"],
      [
        ["--from", "2026-10-04T10:00:00Z", "--to", "10/15/2026"],
        "Invalid time: 10/15/2026 (use ISO 8601 with Z or an offset)",
      ],
    ] as const) {
      const { asked, output, run } = statsRun(argv, async (window) => usageAnswer(window));

      await expect(run, argv.join(" ")).resolves.toBe(2);
      expect(output.stderr, argv.join(" ")).toContain('"code":"USAGE"');
      expect(output.stderr, argv.join(" ")).toContain(`"message":"${message}"`);
      expect(asked, argv.join(" ")).toEqual([]);
      expect(output.stdout).toBe("");
    }
  });

  it("simlock stats --json prints the operation's output unchanged", async () => {
    const answer = usageAnswer(
      { from: NOW - HOUR, to: NOW },
      {
        partial: true,
        requesters: [
          { granted: 1, heldTotalMs: 5, id: "tok_a", label: "ci", rejected: 0, requests: 1 },
        ],
      },
    );
    const { output, run } = statsRun(["--since", "1h", "--json"], async () => answer);

    await expect(run).resolves.toBe(0);

    expect(JSON.parse(output.stdout)).toEqual(answer);
    expect(output.stdout.endsWith("\n")).toBe(true);
  });

  it("asks for the last 24 hours by default, and for --since up to now", async () => {
    const byDefault = statsRun([], async (window) => usageAnswer(window));
    const since = statsRun(["--since", "90m"], async (window) => usageAnswer(window));

    await byDefault.run;
    await since.run;

    expect(byDefault.asked).toEqual([{ from: NOW - 24 * HOUR, to: NOW }]);
    expect(since.asked).toEqual([{ from: NOW - 90 * 60_000, to: NOW }]);
  });

  it("asks for the ISO window --from and --to name, and for --from up to now", async () => {
    const both = statsRun(
      ["--from", "2026-10-04T10:00:00Z", "--to", "2026-10-04T12:00:00Z"],
      async (window) => usageAnswer(window),
    );
    const open = statsRun(["--from", "2026-10-05T10:00:00Z"], async (window) =>
      usageAnswer(window),
    );

    await both.run;
    await open.run;

    expect(both.asked).toEqual([
      { from: Date.parse("2026-10-04T10:00:00Z"), to: Date.parse("2026-10-04T12:00:00Z") },
    ]);
    expect(open.asked).toEqual([{ from: Date.parse("2026-10-05T10:00:00Z"), to: NOW }]);
  });

  it("prints the figures as a table, with the partial note above them", async () => {
    const { output, run } = statsRun(["--since", "30d"], async (window) =>
      usageAnswer(window, { coversFrom: NOW - 60_000, partial: true }),
    );

    await expect(run).resolves.toBe(0);

    const lines = output.stdout.split("\n");
    expect(lines[0]).toBe("Usage from 2026-09-05T12:00:00.000Z to 2026-10-05T12:00:00.000Z");
    expect(lines[1]).toContain("Figures cover from 2026-10-05T11:59:00.000Z");
    expect(lines).toContain("Totals");
  });

  it.each([
    ["", ["--since", "30d"]],
    [" with --csv", ["--since", "30d", "--csv"]],
  ])(
    "prints the HISTORY_NOT_KEPT message on stderr, nothing on stdout, and exits with its code when the window ends before the history%s",
    async (_name, args) => {
      const { output, run } = statsRun(args, async () => {
        throw fromWireError(
          "HISTORY_NOT_KEPT",
          "The history does not reach back to the end of that window; its figures start at 2026-10-05T11:59:00.000Z.",
          { oldestTs: NOW - 60_000 },
        );
      });

      await expect(run).resolves.toBe(12);

      expect(output.stdout).toBe("");
      expect(output.stderr).toContain('"code":"HISTORY_NOT_KEPT"');
      expect(output.stderr).toContain("its figures start at 2026-10-05T11:59:00.000Z");
    },
  );

  const LEDGER_HEADER =
    "requestId,requester,label,platform,model,workerId,source,requestedAt,grantedAt,rejectedAt,endedAt,waitMs,heldMs,turnaroundMs,outcome,probe,reason,endReason";
  const TRUNCATION_NOTICE =
    "The ledger holds the newest 100000 requests of the window; ask for a shorter window for the rest.";

  it("simlock stats --csv prints the header row and one row per ledger entry with times as ISO 8601, durations as whole milliseconds (400, not 400.0), probe as true or false, and asks usage.get with includeLedger: true", async () => {
    const requests = [
      {
        endReason: "explicit",
        endedAt: Date.parse("2026-10-05T11:09:30.000Z"),
        grantedAt: Date.parse("2026-10-05T11:01:02.400Z"),
        heldMs: 507_600.4,
        label: "ci-runner",
        model: "iPhone 16",
        outcome: "granted" as const,
        platform: "ios",
        probe: false,
        requestId: "req_8f2",
        requestedAt: Date.parse("2026-10-05T11:01:02.000Z"),
        requester: "tok_ci",
        source: "warm",
        turnaroundMs: 508_000,
        waitMs: 400,
      },
      {
        outcome: "open" as const,
        platform: "android",
        probe: true,
        requestId: "req_9",
        requestedAt: Date.parse("2026-10-05T11:02:00.000Z"),
        requester: "gw:gw-1:tok_a",
      },
    ];
    const { asked, output, run } = statsRun(["--since", "1h", "--csv"], async (window) =>
      usageAnswer(window, { requests }),
    );

    await expect(run).resolves.toBe(0);

    expect(asked[0]?.includeLedger).toBe(true);
    expect(output.stdout.split("\r\n")).toEqual([
      LEDGER_HEADER,
      "req_8f2,tok_ci,ci-runner,ios,iPhone 16,,warm,2026-10-05T11:01:02.000Z,2026-10-05T11:01:02.400Z,,2026-10-05T11:09:30.000Z,400,507600,508000,granted,false,,explicit",
      "req_9,gw:gw-1:tok_a,,android,,,,2026-10-05T11:02:00.000Z,,,,,,,open,true,,",
      "",
    ]);
  });

  it("simlock stats --csv writes the truncation notice on stderr and exits 0 when ledgerTruncated, and writes no notice otherwise", async () => {
    const truncated = statsRun(["--csv"], async (window) =>
      usageAnswer(window, { ledgerTruncated: true, requests: [] }),
    );
    const whole = statsRun(["--csv"], async (window) => usageAnswer(window, { requests: [] }));

    await expect(truncated.run).resolves.toBe(0);
    await expect(whole.run).resolves.toBe(0);

    expect(truncated.output.stderr).toBe(`${JSON.stringify({ notice: TRUNCATION_NOTICE })}\n`);
    expect(truncated.output.stdout.startsWith(LEDGER_HEADER)).toBe(true);
    expect(whole.output.stderr).toBe("");
    expect(whole.output.stdout.startsWith(LEDGER_HEADER)).toBe(true);
  });

  it("simlock stats refuses --csv with --json as a usage error, exit 2", async () => {
    const accepted = statsRun(["--csv"], async (window) => usageAnswer(window, { requests: [] }));
    const both = statsRun(["--csv", "--json"], async (window) => usageAnswer(window));

    await expect(accepted.run).resolves.toBe(0);
    await expect(both.run).resolves.toBe(2);

    expect(both.output.stderr).toContain('"code":"USAGE"');
    expect(both.output.stderr).toContain('"message":"stats takes --csv or --json, not both"');
    expect(both.asked).toEqual([]);
    expect(both.output.stdout).toBe("");
  });

  it("closes the connection after the answer, and after a failure", async () => {
    let closed = 0;
    const output = outputCapture();
    const connect = (usage: SimlockAdminClient["usage"]) => async () =>
      fakeClient({
        close: async () => {
          closed += 1;
        },
        usage,
      });

    await runCli(
      ["stats"],
      output.environmentWith({ connectAdmin: connect(async (window) => usageAnswer(window)) }),
    );
    await runCli(
      ["stats"],
      output.environmentWith({
        connectAdmin: connect(async () => {
          throw new Error("boom");
        }),
      }),
    );

    expect(closed).toBe(2);
  });

  it("prints its usage on --help without connecting", async () => {
    const output = outputCapture();
    let connected = false;

    const exitCode = await runCli(
      ["stats", "--help"],
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient();
        },
      }),
    );

    expect(exitCode).toBe(0);
    expect(connected).toBe(false);
    expect(output.stdout).toBe(
      "Usage: simlock stats [--since <duration> | --from <ISO> [--to <ISO>]] [--json | --csv]\n",
    );
  });
});

describe("simlock rotate", () => {
  const heldLease = {
    deviceId: "dev_1",
    grantedAt: 0,
    id: "lse_mine",
    lastRenewedAt: 0,
    idChosenByRequester: false,
    ownerId: "some-other-principal",
    requesterId: "test-requester",
    ttlDeadline: 60_000,
    ttlMs: 60_000,
  };

  const two = [heldLease, { ...heldLease, deviceId: "dev_2", id: "lse_other" }];

  async function rotateWith(
    argv: readonly string[],
    leases: readonly (typeof heldLease)[],
    role: "admin" | "agent" = "admin",
    daemonHome?: { role: "gateway"; dataDirectory: string; gatewayPresent: true },
  ) {
    const output = outputCapture();
    const rotations: unknown[] = [];
    let closes = 0;
    const exitCode = await runCli(
      argv,
      output.environmentWith({
        ...(daemonHome === undefined ? {} : { daemonHome }),
        connectAdmin: async () =>
          fakeClient({
            role,
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
            listLeases: () => Promise.resolve({ leases: [...leases] }),
            rotate: (leaseId, orientation, options) => {
              rotations.push({ leaseId, orientation, options });
              return Promise.resolve({ leaseId: `${leaseId}_answered`, orientation });
            },
          }),
      }),
    );
    return { closes: () => closes, exitCode, output, rotations };
  }

  it("a user runs simlock rotate <orientation> [--lease <id>], on a worker or with --gateway, and sees Rotated lease <id> to <orientation>, or a usage error", async () => {
    const only = await rotateWith(["rotate", "landscape-left"], [heldLease]);
    expect(only.exitCode).toBe(0);
    expect(only.rotations).toEqual([
      {
        leaseId: "lse_mine",
        orientation: "landscape_left",
        options: { requesterId: "test-requester" },
      },
    ]);
    expect(only.output.stdout).toBe("Rotated lease lse_mine_answered to landscape_left\n");
    expect(only.closes()).toBe(1);

    const asAgent = await rotateWith(["rotate", "landscape-left"], [heldLease], "agent");
    expect(asAgent.exitCode).toBe(0);
    expect(asAgent.rotations).toEqual([
      { leaseId: "lse_mine", orientation: "landscape_left", options: undefined },
    ]);

    const gateway = {
      role: "gateway",
      dataDirectory: "/simlock/gateway",
      gatewayPresent: true,
    } as const;
    for (const argv of [
      ["--gateway", "rotate", "landscape-left"],
      ["rotate", "landscape-left", "--gateway"],
    ]) {
      const throughGateway = await rotateWith(argv, [heldLease], "agent", gateway);
      expect(throughGateway.exitCode, argv.join(" ")).toBe(0);
      expect(throughGateway.rotations, argv.join(" ")).toEqual([
        { leaseId: "lse_mine", orientation: "landscape_left", options: undefined },
      ]);
      expect(throughGateway.output.stdout, argv.join(" ")).toBe(
        "Rotated lease lse_mine_answered to landscape_left\n",
      );
    }

    for (const argv of [
      ["rotate", "--lease", "lse_other", "left"],
      ["rotate", "left", "--lease", "lse_other"],
      ["rotate", "left", "--lease=lse_other"],
    ]) {
      const named = await rotateWith(argv, two);
      expect(named.exitCode).toBe(0);
      expect(named.rotations).toEqual([
        {
          leaseId: "lse_other",
          orientation: "landscape_left",
          options: { requesterId: "test-requester" },
        },
      ]);
    }

    for (const [spelling, orientation] of [
      ["LEFT", "landscape_left"],
      [" left ", "landscape_left"],
      ["upside-down", "portrait_upside_down"],
    ]) {
      const spelled = await rotateWith(["rotate", spelling as string], [heldLease]);
      expect(spelled.exitCode).toBe(0);
      expect(spelled.output.stdout).toBe(`Rotated lease lse_mine_answered to ${orientation}\n`);
    }

    const refusals: [readonly string[], readonly (typeof heldLease)[], RegExp][] = [
      [["rotate", "sideways"], [heldLease], /^Unknown orientation sideways; use portrait,/],
      [["rotate", "auto"], [heldLease], /^Unknown orientation auto;/],
      [["rotate", "landscapeLeft"], [heldLease], /^Unknown orientation landscapeLeft;/],
      [["rotate"], [heldLease], /^Expected orientation/],
      [["rotate", "left"], [], /test-requester/],
      [["rotate", "left"], two, /lse_mine.*lse_other.*--lease <id>/s],
    ];
    for (const [argv, leases, message] of refusals) {
      const refused = await rotateWith(argv, leases);
      expect(refused.exitCode).toBe(2);
      expect(refused.rotations).toEqual([]);
      expect(JSON.parse(refused.output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringMatching(message) },
      });
    }

    const unsupported = outputCapture();
    let unsupportedCloses = 0;
    await expect(
      runCli(
        ["rotate", "left", "--lease", "lse_android"],
        unsupported.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              close: () => {
                unsupportedCloses += 1;
                return Promise.resolve();
              },
              rotate: () =>
                Promise.reject(
                  new SimlockError(
                    "ROTATION_UNSUPPORTED",
                    "domain",
                    "Lease lse_android is on an Android emulator; only an iOS simulator can be rotated",
                    {
                      class: "emulator",
                      leaseId: "lse_android",
                      physical: false,
                      platform: "android",
                    },
                  ),
                ),
            }),
        }),
      ),
    ).resolves.toBe(12);
    expect(JSON.parse(unsupported.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
      error: {
        code: "ROTATION_UNSUPPORTED",
        message:
          "Lease lse_android is on an Android emulator; only an iOS simulator can be rotated",
      },
    });
    expect(unsupported.stdout).toBe("");
    expect(unsupportedCloses).toBe(1);

    const help = await rotateWith(["rotate", "--help"], [heldLease]);
    expect(help.exitCode).toBe(0);
    expect(help.output.stdout).toBe(
      "Usage: simlock rotate <portrait|portrait-upside-down|landscape-left|landscape-right> [--lease <id>]\n",
    );
    expect(help.rotations).toEqual([]);
    const listing = outputCapture();
    await runCli(["--help"], listing.environmentWith());
    expect(listing.stdout).toContain("  rotate <orientation> [--lease <id>]");
  });
});
