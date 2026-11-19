import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeParentWatch } from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import type { LeaseGrant } from "../simlock-client/client.js";
import { runCli, type CliEnvironment } from "./index.js";
import { EMPTY_STATUS, detachedGrant, fakeClient, outputCapture } from "./test-index.js";

describe("CLI: exit codes", () => {
  /**
   * why: ADR 0005 §19c's other half. Same command, same refusals, same exit code -- the only thing
   * that changes is where the process runs and how its output gets here. `runPassthrough` is
   * deliberately wired in each of these: a remote invocation that quietly spawned locally
   * would pass every assertion about output and exit code while doing the wrong thing.
   *
   * The switch is the daemon's own `mode` (§19c): a `gateway` owns no devices, so a command
   * it resolved could not run here anyway. Nothing about the CLI's transport decides it.
   */
  describe("remote passthrough (ADR 0005 device.exec)", () => {
    const gatewayStatus = {
      ...EMPTY_STATUS,
      daemon: {
        health: "running" as const,
        mode: "gateway" as const,
        version: "0.0.0-test",
        update: null,
        lastUpdateFailure: null,
        latestVersion: null,
      },
    };
    const ownLease = {
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

    it("runs the command on the daemon, prints the streamed output, and exits with its code", async () => {
      const output = outputCapture();
      const seen: unknown[] = [];
      let ranLocally = false;

      await expect(
        runCli(
          ["adb", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: (input, options) => {
                  seen.push(input);
                  options?.onOutput?.({ chunk: "ro.build", stream: "stdout" });
                  options?.onOutput?.({ chunk: "a warning\n", stream: "stderr" });
                  options?.onOutput?.({ chunk: ".version=15\n", stream: "stdout" });
                  return Promise.resolve({ exitCode: 9 });
                },
              }),
            runPassthrough: async () => {
              ranLocally = true;
              return 0;
            },
          }),
        ),
      ).resolves.toBe(9);

      expect(ranLocally).toBe(false);
      // why: `requesterId` rides along because this connection resolved to the admin role, where
      // the operation reads it (and requires it to match the lease). See the agent-role case
      // below for the other half.
      expect(seen).toEqual([
        {
          args: ["shell", "getprop"],
          leaseId: "lse_mine",
          requesterId: "test-requester",
          stdin: "",
          tool: "adb",
        },
      ]);
      // why: Chunks land on the stream they were written to, unjoined and in order -- a caller
      // piping this sees what it would have seen locally.
      expect(output.stdout).toBe("ro.build.version=15\n");
      // why: The agent-fallback notice this fixture's credential-less connection writes is the only
      // other thing on stderr; the command's own chunk lands there verbatim.
      expect(output.stderr).toContain("a warning\n");
    });

    it("names the lease from the requester id rather than from a flag of its own", async () => {
      // why: Every argument after the tool name belongs to the tool, so identity is
      // the only thing left to select a lease with -- and `--agent-id`/`SIMLOCK_AGENT_ID`
      // already is that identity. A requester holding no lease is a usage error naming it.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [{ ...ownLease, id: "lse_theirs", requesterId: "someone-else" }],
                  }),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("test-requester") },
      });
    });

    it("exits 10 when the daemon killed the command for outrunning exec.timeoutMs", async () => {
      // why: The exit code comes from `ERROR_TABLE`'s own column (ADR 0003 §7): 10, the same code
      // the other "you ran out of time" outcome (`QUEUE_TIMEOUT`) uses, rather than the
      // generic 1 a command that merely failed would get.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "logcat"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: () =>
                  Promise.reject(
                    new SimlockError(
                      "EXEC_TIMEOUT",
                      "domain",
                      "`adb logcat` exceeded exec.timeoutMs (600000ms) and was killed",
                      {},
                    ),
                  ),
              }),
          }),
        ),
      ).resolves.toBe(10);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "EXEC_TIMEOUT", message: expect.stringContaining("exec.timeoutMs") },
      });
    });

    it("without --lease, for a requester holding two leases, fails with a usage error naming both leases and --lease", async () => {
      const output = outputCapture();

      await expect(
        runCli(
          ["simctl", "list"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [ownLease, { ...ownLease, deviceId: "dev_2", id: "lse_other" }],
                  }),
                exec: () => Promise.reject(new Error("must not run")),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: {
          code: "USAGE",
          message: expect.stringMatching(/lse_mine.*lse_other.*--lease <id>/s),
        },
      });
    });

    it("takes `--lease <id>` out of the arguments and runs against that lease", async () => {
      // why: The flag exists only on this path, so it is stripped here rather than parsed with the
      // CLI's own flags: locally every argument after the tool name belongs to the tool.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_named", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.reject(new Error("must not need the lease list")),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        {
          args: ["shell", "getprop"],
          leaseId: "lse_named",
          requesterId: "test-requester",
          stdin: "",
          tool: "adb",
        },
      ]);
    });

    it("sends stdin on device.exec only when --stdin was given", async () => {
      // why: `readStdin` is a `CliEnvironmentPorts` seam this test injects directly -- it exercises
      // the wiring from that port's result to `device.exec`'s `stdin`, not the default
      // `readPipedStdin` implementation that reads a real pipe to EOF; that one is tested on
      // its own below, since a fake here would not exercise it at all.
      const cases = [
        {
          argv: ["adb", "shell", "cat"],
          readable: false,
          expected: { args: ["shell", "cat"], stdin: "", tool: "adb" },
        },
        {
          argv: ["simctl", "list"],
          readable: false,
          expected: { args: ["list"], stdin: "", tool: "simctl" },
        },
        {
          argv: ["adb", "--stdin", "shell", "cat"],
          readable: true,
          expected: { args: ["shell", "cat"], stdin: "piped payload\n", tool: "adb" },
        },
        {
          argv: ["simctl", "--stdin", "list"],
          readable: true,
          expected: { args: ["list"], stdin: "piped payload\n", tool: "simctl" },
        },
      ];

      for (const { argv, readable, expected } of cases) {
        const output = outputCapture();
        const seen: unknown[] = [];

        await expect(
          runCli(
            argv,
            output.environmentWith({
              connectAdmin: async () =>
                fakeClient({
                  getStatus: () => Promise.resolve(gatewayStatus),
                  listLeases: () => Promise.resolve({ leases: [ownLease] }),
                  exec: (input) => {
                    seen.push(input);
                    return Promise.resolve({ exitCode: 0 });
                  },
                }),
              readStdin: readable
                ? async () => "piped payload\n"
                : () => Promise.reject(new Error("stdin must not be read without --stdin")),
            }),
          ),
        ).resolves.toBe(0);
        expect(seen).toEqual([{ ...expected, leaseId: "lse_mine", requesterId: "test-requester" }]);
      }
    });

    it("sends no requesterId when the connection fell back to the agent role", async () => {
      // why: An agent session is gated on the lease it owns and its `requesterId` is ignored
      // entirely, so sending one would be noise that reads like authorization.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                role: "agent",
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["devices"], leaseId: "lse_mine", stdin: "", tool: "adb" }]);
    });

    it("spawns locally against a worker, accepting and ignoring --lease", async () => {
      // why: The other half of the same switch, and the reason `--lease` is accepted on both: one
      // command line has to work against either kind of daemon. A worker takes
      // the flag, drops it, and passes the rest to the tool untouched.
      const output = outputCapture();
      const ran: unknown[] = [];
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_ignored", "shell", "getprop"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                exec: () => Promise.reject(new Error("must not exec remotely")),
                resolvePassthrough: (input) => {
                  seen.push(input);
                  return Promise.resolve({ args: ["-P", "5038"], command: "adb", env: {} });
                },
              }),
            runPassthrough: async (command) => {
              ran.push(command);
              return 0;
            },
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["shell", "getprop"], tool: "adb" }]);
      expect(ran).toHaveLength(1);
    });

    it("relabels an unknown passthrough tool as USAGE, like a refusal", async () => {
      // why: ADR 0005 §19c: the CLI keeps no copy of the refusal list and relabels whatever the
      // daemon answers. `UNKNOWN_PASSTHROUGH_TOOL` is the other half of that answer, and it
      // has to read the same as a refused verb does -- exit 2, one `USAGE` line.
      const output = outputCapture();

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.resolve({ leases: [ownLease] }),
                exec: () =>
                  Promise.reject(
                    new SimlockError(
                      "UNKNOWN_PASSTHROUGH_TOOL",
                      "domain",
                      "No driver provides a adb passthrough",
                      { tool: "adb" },
                    ),
                  ),
              }),
          }),
        ),
      ).resolves.toBe(2);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("No driver provides") },
      });
    });

    it("takes --lease as the last argument, and refuses an empty one", async () => {
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_only"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        { args: [], leaseId: "lse_only", requesterId: "test-requester", stdin: "", tool: "adb" },
      ]);

      const missingValue = outputCapture();
      await expect(
        runCli(
          ["adb", "--lease"],
          missingValue.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(gatewayStatus) }),
          }),
        ),
      ).resolves.toBe(2);

      const emptyValue = outputCapture();
      await expect(
        runCli(
          ["adb", "--lease=", "devices"],
          emptyValue.environmentWith({
            connectAdmin: async () =>
              fakeClient({ getStatus: () => Promise.resolve(gatewayStatus) }),
          }),
        ),
      ).resolves.toBe(2);
    });

    it("fails a local passthrough with the status.get error when the daemon cannot answer", async () => {
      // why: The switch reads `mode` off `status.get`, so an unreachable daemon fails there rather
      // than at the passthrough -- and the CLI reports that call's own error rather than
      // dressing it up as a passthrough failure.
      const output = outputCapture();
      let ranLocally = false;

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () =>
                  Promise.reject(
                    new SimlockError(
                      "DAEMON_CONNECTION_LOST",
                      "transport",
                      "Daemon connection closed",
                      {},
                    ),
                  ),
              }),
            runPassthrough: async () => {
              ranLocally = true;
              return 0;
            },
          }),
        ),
      ).resolves.toBe(1);
      expect(ranLocally).toBe(false);
      expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "DAEMON_CONNECTION_LOST", message: "Daemon connection closed" },
      });
    });

    it("uses an agent connection's own lease list without filtering it by requester", async () => {
      // why: `lease.list` already answers per role: an agent sees only what it owns. Filtering that
      // by `requesterId` as well would drop a lease it demonstrably owns whenever the two
      // differ -- an `--agent-id` used on the lease but not on this invocation.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "devices"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                role: "agent",
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () =>
                  Promise.resolve({
                    leases: [{ ...ownLease, id: "lse_owned", requesterId: "another-agent-id" }],
                  }),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([{ args: ["devices"], leaseId: "lse_owned", stdin: "", tool: "adb" }]);
    });

    it("takes --stdin before or after --lease, and passes it to the tool after the tool's first argument", async () => {
      const cases = [
        {
          argv: ["adb", "--stdin", "--lease", "lse_named", "shell", "cat"],
          expected: { args: ["shell", "cat"], leaseId: "lse_named", stdin: "sent" },
        },
        {
          argv: ["adb", "--lease", "lse_named", "--stdin", "shell", "cat"],
          expected: { args: ["shell", "cat"], leaseId: "lse_named", stdin: "sent" },
        },
        {
          argv: ["adb", "shell", "--stdin"],
          expected: { args: ["shell", "--stdin"], leaseId: "lse_mine", stdin: "" },
        },
      ];

      for (const { argv, expected } of cases) {
        const output = outputCapture();
        const seen: unknown[] = [];

        await expect(
          runCli(
            argv,
            output.environmentWith({
              connectAdmin: async () =>
                fakeClient({
                  getStatus: () => Promise.resolve(gatewayStatus),
                  listLeases: () => Promise.resolve({ leases: [ownLease] }),
                  exec: (input) => {
                    seen.push(input);
                    return Promise.resolve({ exitCode: 0 });
                  },
                }),
              readStdin: async () => "sent",
            }),
          ),
        ).resolves.toBe(0);
        expect(seen).toEqual([{ ...expected, requesterId: "test-requester", tool: "adb" }]);
      }
    });

    it("spawns locally against a worker, accepting and ignoring --stdin", async () => {
      const cases = [
        { argv: ["adb", "--stdin", "shell", "cat"], args: ["shell", "cat"] },
        { argv: ["adb", "--stdin", "--lease", "lse_x", "shell", "cat"], args: ["shell", "cat"] },
        { argv: ["adb", "--lease", "lse_x", "--stdin", "shell", "cat"], args: ["shell", "cat"] },
        { argv: ["adb", "shell", "--stdin"], args: ["shell", "--stdin"] },
      ];

      for (const { argv, args } of cases) {
        const output = outputCapture();
        const seen: unknown[] = [];

        await expect(
          runCli(
            argv,
            output.environmentWith({
              connectAdmin: async () =>
                fakeClient({
                  exec: () => Promise.reject(new Error("must not exec remotely")),
                  resolvePassthrough: (input) => {
                    seen.push(input);
                    return Promise.resolve({ args: [], command: "adb", env: {} });
                  },
                }),
              readStdin: () => Promise.reject(new Error("a worker never reads stdin")),
              runPassthrough: async () => 0,
            }),
          ),
        ).resolves.toBe(0);
        expect(seen).toEqual([{ args, tool: "adb" }]);
      }
    });

    it("stops scanning for --lease at the tool's own first argument", async () => {
      // why: Everything from the tool's subcommand onwards is the tool's, so a `--lease` there is
      // an argument to *it* -- typed text, a filter, an operand -- and travels through.
      const output = outputCapture();
      const seen: unknown[] = [];

      await expect(
        runCli(
          ["adb", "--lease", "lse_mine", "shell", "input", "text", "--lease"],
          output.environmentWith({
            connectAdmin: async () =>
              fakeClient({
                getStatus: () => Promise.resolve(gatewayStatus),
                listLeases: () => Promise.reject(new Error("must not need the lease list")),
                exec: (input) => {
                  seen.push(input);
                  return Promise.resolve({ exitCode: 0 });
                },
              }),
          }),
        ),
      ).resolves.toBe(0);
      expect(seen).toEqual([
        {
          args: ["shell", "input", "text", "--lease"],
          leaseId: "lse_mine",
          requesterId: "test-requester",
          stdin: "",
          tool: "adb",
        },
      ]);
    });
  });

  it("lists both tool passthroughs in root help", async () => {
    const output = outputCapture();

    await expect(runCli([], output.environmentWith())).resolves.toBe(0);
    expect(output.stdout).toContain("simctl <args...>");
    expect(output.stdout).toContain("adb <args...>");
  });

  it("releases and exits when the watched parent process dies, via the same path as a signal", async () => {
    const output = outputCapture();
    const parentWatch = new FakeParentWatch();
    const heldGrant: LeaseGrant = {
      ...detachedGrant,
      lease: { ...detachedGrant.lease, id: "lse_parent_death" },
    };
    const released: unknown[] = [];

    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (_input, _options) => Promise.resolve(heldGrant),
            releaseLease: (input) => {
              released.push(input);
              return Promise.resolve({ leaseId: input.leaseId });
            },
          }),
        parentPid: 4321,
        parentWatch,
        signals: new EventEmitter() as unknown as CliEnvironment["signals"],
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    parentWatch.exit(4321);

    await expect(run).resolves.toBe(0);
    expect(released).toEqual([{ leaseId: "lse_parent_death" }]);
  });

  it("--bind-pid overrides which pid the CLI watches for parent death", async () => {
    const output = outputCapture();
    const parentWatch = new FakeParentWatch();
    const heldGrant: LeaseGrant = {
      ...detachedGrant,
      lease: { ...detachedGrant.lease, id: "lse_bind_pid" },
    };
    const released: unknown[] = [];

    const run = runCli(
      ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "9876"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (_input, _options) => Promise.resolve(heldGrant),
            releaseLease: (input) => {
              released.push(input);
              return Promise.resolve({ leaseId: input.leaseId });
            },
          }),
        parentPid: 4321,
        parentWatch,
        signals: new EventEmitter() as unknown as CliEnvironment["signals"],
      }),
    );

    await vi.waitFor(() => expect(output.stdout).not.toBe(""));
    // why: The captured parent is not the one being watched any more, so its death is ignored.
    parentWatch.exit(4321);
    expect(released).toEqual([]);
    parentWatch.exit(9876);

    await expect(run).resolves.toBe(0);
    expect(released).toEqual([{ leaseId: "lse_bind_pid" }]);
  });

  it("rejects a non-numeric --bind-pid as a structured USAGE error", async () => {
    const output = outputCapture();

    await expect(
      runCli(
        ["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--bind-pid", "nope"],
        output.environmentWith(),
      ),
    ).resolves.toBe(2);
    expect(JSON.parse(output.stderr)).toMatchObject({ error: { code: "USAGE" } });
  });

  // why: the CLI reference promises a missing required argument ends with the `simlock --help`
  // pointer, and guards reach it two ways -- an explicit `withHelpHint` call or
  // `requiredPositional` -- either of which can be dropped silently, so a sample of both
  // paths (a command guard and the router's unknown command) is pinned here.
  it("points a missing required argument at simlock --help", async () => {
    const output = outputCapture();
    await expect(runCli(["lease"], output.environmentWith())).resolves.toBe(2);
    expect(JSON.parse(output.stderr).error).toMatchObject({
      code: "USAGE",
      message: "lease requires --platform <ios|android> (run `simlock --help` for usage)",
    });
  });

  it("points an unknown command at simlock --help", async () => {
    const output = outputCapture();
    await expect(runCli(["nope"], output.environmentWith())).resolves.toBe(2);
    expect(JSON.parse(output.stderr).error).toMatchObject({
      code: "USAGE",
      message: "Unknown command: nope (run `simlock --help` for usage)",
    });
  });
});
