import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeServiceManager,
  serviceDefinition,
  type ServiceManager,
  type ServiceState,
} from "../ports/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture, simlockError } from "./test-index.js";

async function runDaemonStatus(
  testCase: {
    readonly role: "worker" | "gateway";
    readonly running: boolean;
    readonly state: ServiceState | undefined;
  },
  json: boolean,
): Promise<{ readonly stdout: string }> {
  const home = "/Users/me";
  const output = outputCapture();
  const manager =
    testCase.state === undefined ? undefined : new FakeServiceManager({ state: testCase.state });
  const environment = output.environmentWith({
    daemonHome: { role: testCase.role, dataDirectory: "/simlock", gatewayPresent: false },
    connectExistingAdmin: async () => {
      if (!testCase.running) throw new Error("connect ECONNREFUSED");
      return fakeClient();
    },
    service: {
      manager,
      platform: manager === undefined ? "linux" : "darwin",
      user: () => "me",
      definition: async () =>
        serviceDefinition({
          role: testCase.role,
          root: join(home, ".simlock"),
          dataDirectory: "/simlock",
          home,
          nodePath: "/Users/me/.nvm/versions/node/v22.13.0/bin/node",
          mainPath: "/Users/me/simlock/dist/daemon/main.js",
          env: {},
        }),
    },
  });
  await expect(
    runCli(["daemon", "status", ...(json ? ["--json"] : [])], environment),
  ).resolves.toBe(0);
  return output;
}

describe("CLI: daemon status (ADR 0003 §11)", () => {
  it.each([
    { name: "the socket cannot be reached at all", error: () => new Error("connect ECONNREFUSED") },
    {
      name: "a transport-kind SimlockError (connection lost)",
      error: () => simlockError("DAEMON_CONNECTION_LOST"),
    },
  ])("reports stopped when $name", async ({ error }) => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw error();
          },
        }),
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({ status: "stopped" });
  });

  it("distinguishes a refused handshake (socket reachable) from an absent socket", async () => {
    const output = outputCapture();
    await expect(
      runCli(
        ["daemon", "status", "--json"],
        output.environmentWith({
          connectExistingAdmin: async () => {
            throw simlockError("ADMIN_AUTHENTICATION_FAILED");
          },
        }),
      ),
    ).resolves.toBe(1);
    const parsed = JSON.parse(output.stdout) as { status: string; error: { code: string } };
    expect(parsed.status).toBe("handshake-refused");
    expect(parsed.error.code).toBe("ADMIN_AUTHENTICATION_FAILED");
  });

  it("never auto-launches the daemon for daemon status", async () => {
    const output = outputCapture();
    let launched = false;
    await runCli(
      ["daemon", "status"],
      output.environmentWith({
        connectAdmin: async () => {
          launched = true;
          return fakeClient();
        },
        connectExistingAdmin: async () => fakeClient(),
      }),
    );
    expect(launched).toBe(false);
  });

  it("daemon status prints the Service: line and the service field in --json, for a worker or a gateway, running or stopped, and none on an unsupported platform", async () => {
    const home = "/Users/me";
    const node = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const main = "/Users/me/simlock/dist/daemon/main.js";
    const worker = "com.callstack.simlock.worker";
    const gateway = "com.callstack.simlock.gateway";
    const plist = (name: string) => join(home, "Library", "LaunchAgents", `${name}.plist`);
    const cases: readonly {
      readonly label: string;
      readonly role: "worker" | "gateway";
      readonly running: boolean;
      readonly state: ServiceState | undefined;
      readonly line: string | undefined;
      readonly service: Record<string, unknown> | undefined;
    }[] = [
      {
        label: "not installed, stopped",
        role: "worker",
        running: false,
        state: { state: "not-installed" },
        line: "Service: not installed",
        service: { state: "not-installed", manager: "launchd", name: worker },
      },
      {
        label: "installed, running",
        role: "worker",
        running: true,
        state: { state: "installed", path: plist(worker) },
        line: `Service: installed (launchd, ${worker})`,
        service: { state: "installed", manager: "launchd", name: worker, path: plist(worker) },
      },
      {
        label: "not loaded, running",
        role: "worker",
        running: true,
        state: { state: "not-loaded", path: plist(worker) },
        line: `Service: not loaded (launchd, ${worker}): commands start the daemon without it`,
        service: { state: "not-loaded", manager: "launchd", name: worker, path: plist(worker) },
      },
      {
        label: "Node path gone, stopped",
        role: "worker",
        running: false,
        state: { state: "broken", path: plist(worker), missing: [node] },
        line: `Service: broken (launchd, ${worker}): ${node} is gone; run simlock daemon install`,
        service: {
          state: "broken",
          manager: "launchd",
          name: worker,
          path: plist(worker),
          missing: [node],
        },
      },
      {
        label: "both paths gone, stopped",
        role: "worker",
        running: false,
        state: { state: "broken", path: plist(worker), missing: [node, main] },
        line: `Service: broken (launchd, ${worker}): ${node}, ${main} are gone; run simlock daemon install`,
        service: {
          state: "broken",
          manager: "launchd",
          name: worker,
          path: plist(worker),
          missing: [node, main],
        },
      },
      {
        label: "gateway, running",
        role: "gateway",
        running: true,
        state: { state: "installed", path: plist(gateway) },
        line: `Service: installed (launchd, ${gateway})`,
        service: { state: "installed", manager: "launchd", name: gateway, path: plist(gateway) },
      },
      {
        label: "unsupported platform",
        role: "worker",
        running: true,
        state: undefined,
        line: undefined,
        service: undefined,
      },
    ];
    for (const testCase of cases) {
      const human = await runDaemonStatus(testCase, false);
      const lines = human.stdout.trimEnd().split("\n");
      expect(
        [lines[0], ...lines.filter((line) => line.startsWith("Service:"))],
        testCase.label,
      ).toEqual([
        testCase.running ? "Daemon: running (worker)" : "Daemon stopped",
        ...(testCase.line === undefined ? [] : [testCase.line]),
      ]);
      if (testCase.line !== undefined)
        expect(lines.at(-1), `${testCase.label} last line`).toBe(testCase.line);
      const json = JSON.parse((await runDaemonStatus(testCase, true)).stdout) as {
        readonly service?: unknown;
      };
      expect(json.service, `${testCase.label} --json`).toEqual(testCase.service);
    }
  });

  it("daemon status fails with the service manager's error instead of printing Daemon stopped", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      daemonHome: { role: "worker", dataDirectory: "/simlock", gatewayPresent: false },
      connectExistingAdmin: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      service: {
        manager: {
          manager: "launchd",
          state: async () => {
            throw new Error("launchctl timed out");
          },
        } as unknown as ServiceManager,
        platform: "darwin",
        user: () => "me",
        definition: async () =>
          serviceDefinition({
            role: "worker",
            root: join("/Users/me", ".simlock"),
            dataDirectory: "/simlock",
            home: "/Users/me",
            nodePath: "/n",
            mainPath: "/m.js",
            env: {},
          }),
      },
    });

    await expect(runCli(["daemon", "status"], environment)).resolves.toBe(1);

    expect(output.stdout).not.toContain("Daemon stopped");
    expect(output.stderr).toContain("launchctl timed out");
  });

  it("asks the daemon to purge orphans only once the operator has confirmed", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--purge-orphans"],
        output.environmentWith({
          confirm: async () => true,
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [], sources: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    expect(seen).toEqual([{ fix: false, purgeOrphans: true }]);
  });

  it("prints one stderr line per prerequisite finding, keeps the JSON report on stdout, and exits 0", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "prerequisite-missing" as const,
        message: "The Android emulator package is not installed.",
        platform: "android" as const,
        prerequisite: "android-emulator",
        remedy: "Run `sdkmanager --install emulator`.",
      },
      {
        kind: "prerequisite-missing" as const,
        message: "Xcode is not installed.",
        platform: "ios" as const,
        prerequisite: "xcode",
        remedy: "Run `xcode-select`.",
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

    // why: The harness has no admin credential, so a connection notice precedes these lines.
    expect(output.stderr.split("\n").filter((line) => line.startsWith("Missing"))).toEqual([
      "Missing [android] android-emulator: The Android emulator package is not installed. " +
        "Run `sdkmanager --install emulator`.",
      "Missing [ios] xcode: Xcode is not installed. Run `xcode-select`.",
    ]);
    expect(JSON.parse(output.stdout)).toEqual({ findings, sources: [] });
  });

  it("simlock doctor prints a service-broken finding to stderr, naming each missing path, and keeps the finding in the JSON report", async () => {
    const node = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const main = "/Users/me/simlock/dist/daemon/main.js";
    for (const testCase of [
      {
        missing: [node],
        line: `Service broken: com.callstack.simlock.worker (launchd) names missing ${node}. Run \`simlock daemon install\` again.`,
      },
      {
        missing: [node, main],
        line: `Service broken: com.callstack.simlock.worker (launchd) names missing ${node}, ${main}. Run \`simlock daemon install\` again.`,
      },
    ]) {
      const output = outputCapture();
      const findings = [
        {
          kind: "service-broken" as const,
          manager: "launchd" as const,
          name: "com.callstack.simlock.worker",
          missing: testCase.missing,
          remedy: "Run `simlock daemon install` again.",
        },
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

      expect(output.stderr.split("\n").filter((line) => line.startsWith("Service broken"))).toEqual(
        [testCase.line],
      );
      expect(JSON.parse(output.stdout)).toEqual({ findings, sources: [] });
    }
  });

  it("simlock doctor prints a driver-advisory finding to stderr as `Warning [<platform>] <code>: <message>`", async () => {
    const output = outputCapture();
    const findings = [
      {
        code: "device-profile-hidden",
        kind: "driver-advisory" as const,
        message: '"Pixel 9" in devices.xml is not used',
        platform: "android" as const,
      },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] } as never) }),
        }),
      ),
    ).resolves.toBe(0);

    expect(output.stderr.split("\n")).toContain(
      'Warning [android] device-profile-hidden: "Pixel 9" in devices.xml is not used',
    );
  });

  it("simlock doctor writes `Unavailable [<platform>] <reason>: <detail>` on stderr for a driver-unavailable finding and prints the report on stdout unchanged", async () => {
    const output = outputCapture();
    const findings = [
      {
        detail: "Refusing the ios device set: bad. Restart the daemon.",
        kind: "driver-unavailable" as const,
        platform: "ios" as const,
        reason: "invalid-device-set",
      },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] } as never) }),
        }),
      ),
    ).resolves.toBe(0);

    expect(output.stderr.split("\n")).toContain(
      "Unavailable [ios] invalid-device-set: Refusing the ios device set: bad. Restart the daemon.",
    );
    expect(JSON.parse(output.stdout)).toEqual({ findings, sources: [] });
  });

  it("simlock doctor writes agent-device  fail  <message>; <remedy> on stderr for a module-unavailable finding, one line of at most 500 characters per part, after the advisory, prerequisite and warm-pool lines, prints the report on stdout unchanged, and exits 0", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "module-unavailable" as const,
        module: "agent-device",
        message: `found 0.20.3,\n  need ${"x".repeat(600)}`,
        remedy: `install agent-device 0.21.28 or later,\nthen ${"y".repeat(600)}`,
      },
      {
        kind: "warm-pool-target-unreachable" as const,
        message: "iOS 27.0 is not installed",
        platform: "ios" as const,
        reason: "runtime-missing" as const,
        remedy: "run simlock component install ios 27.0",
        target: "iPhone 17 / 27.0 / full",
      },
      {
        kind: "prerequisite-missing" as const,
        message: "Xcode is not installed.",
        platform: "ios" as const,
        prerequisite: "xcode",
        remedy: "Run `xcode-select`.",
      },
      {
        code: "slim-runtime-unsupported",
        kind: "driver-advisory" as const,
        message: "detail",
        platform: "ios" as const,
      },
    ];

    await expect(
      runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] } as never) }),
        }),
      ),
    ).resolves.toBe(0);

    const lines = output.stderr.split("\n");
    const index = lines.findIndex((line) => line.startsWith("agent-device  fail  "));
    expect(index).toBeGreaterThan(-1);
    expect(lines[index]).toBe(
      `agent-device  fail  found 0.20.3, need ${"x".repeat(500 - "found 0.20.3, need ".length)}; ${("install agent-device 0.21.28 or later, then " + "y".repeat(600)).slice(0, 500)}`,
    );
    expect(lines.filter((line) => line.startsWith("agent-device"))).toHaveLength(1);
    for (const earlier of ["Warning [ios]", "Missing [ios]", "warm-pool-target-unreachable"]) {
      expect(lines.findIndex((line) => line.startsWith(earlier))).toBeLessThan(index);
      expect(lines.findIndex((line) => line.startsWith(earlier))).toBeGreaterThan(-1);
    }
    expect(JSON.parse(output.stdout)).toEqual({ findings, sources: [] });
  });

  it("simlock doctor writes <module>  fail  … for a finding of another module", async () => {
    const output = outputCapture();
    const findings = [
      {
        kind: "module-unavailable" as const,
        message: "needs\n  tmux",
        module: "other-mod",
        remedy: "install tmux",
      },
    ];

    await runCli(
      ["doctor"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] } as never) }),
      }),
    );

    expect(output.stderr.split("\n")).toContain("other-mod  fail  needs tmux; install tmux");
    expect(output.stderr).not.toContain("agent-device");
  });

  it("simlock doctor writes Warning [<module>] <message> <remedy> for a module-advisory finding, escaped, beside a module-unavailable line", async () => {
    const advisory = {
      kind: "module-advisory" as const,
      message: "fseventsd uses 28.0 GB\u001b[31m",
      module: "fseventsd",
      remedy: "Restart it.",
    };
    const unavailable = {
      kind: "module-unavailable" as const,
      message: "needs tmux",
      module: "other-mod",
      remedy: "install tmux",
    };
    const run = async (findings: readonly unknown[]) => {
      const output = outputCapture();
      await runCli(
        ["doctor"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({ runDoctor: () => Promise.resolve({ findings, sources: [] } as never) }),
        }),
      );
      return output.stderr.split("\n").filter((line) => line !== "" && !line.startsWith("{"));
    };

    const alone = await run([advisory]);
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatch(/^Warning \[fseventsd\] fseventsd uses 28\.0 GB\S* Restart it\.$/);
    expect(alone[0]).not.toContain("\u001b");
    expect(await run([advisory, unavailable])).toHaveLength(2);
  });

  it("keeps --purge-orphans off the wire when --fix is all that was asked for", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--fix"],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [], sources: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    // why: The upgrade contract: `doctor --fix` running unattended in CI never becomes
    // destructive on its own (ADR 0001, decision 6).
    expect(seen).toEqual([{ fix: true, purgeOrphans: false }]);
  });

  it.each([
    ["declined", async () => false],
    // why: Explicitly absent: the shared harness defaults `confirm` to an auto-yes, so leaving it
    // out would test the default rather than the no-terminal case.
    ["unavailable", undefined],
  ] as const)(
    "refuses --purge-orphans and contacts nobody when confirmation is %s",
    async (_case, confirm) => {
      const output = outputCapture();
      let connected = false;

      await expect(
        runCli(
          ["doctor", "--purge-orphans"],
          output.environmentWith({
            // why: `exactOptionalPropertyTypes`: an explicitly-absent confirm has to be spread in,
            // not passed as `undefined`.
            ...(confirm === undefined ? { confirm: undefined } : { confirm }),
            connectAdmin: async () => {
              connected = true;
              return fakeClient();
            },
          }),
        ),
      ).resolves.toBe(2);

      expect(connected).toBe(false);
      expect(JSON.parse(output.stderr)).toEqual({
        error: { code: "USAGE", message: expect.stringContaining("--yes") },
      });
    },
  );

  it("takes --yes as the confirmation, so an unattended purge needs no terminal", async () => {
    const output = outputCapture();
    const seen: unknown[] = [];

    await expect(
      runCli(
        ["doctor", "--purge-orphans", "--yes"],
        output.environmentWith({
          confirm: async () => {
            throw new Error("--yes must not ask");
          },
          connectAdmin: async () =>
            fakeClient({
              runDoctor: (input) => {
                seen.push(input);
                return Promise.resolve({ findings: [], sources: [] });
              },
            }),
        }),
      ),
    ).resolves.toBe(0);

    expect(seen).toEqual([{ fix: false, purgeOrphans: true }]);
  });
});
