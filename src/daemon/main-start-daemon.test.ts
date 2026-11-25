import { hasEvent, historyEventsWhen } from "./test-main-history.js";
import { queryState } from "./test-main-state.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Config, type DriverToolVersion, REDACTED_VALUE } from "../core/index.js";
import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import {
  FakeClock,
  FakeHostInfo,
  daemonDataDirectory,
  FakeServiceManager,
  serviceDefinition,
  type ServiceDefinition,
  type ServiceManager,
  type ServiceState,
  MemoryFilesystem,
  ScriptedProcessRunner,
  TaskSchedulerServiceManager,
} from "../ports/index.js";
import { productionServiceCheck } from "./main.js";
import type { DaemonServer } from "./server.js";
import { start, stopDaemons, temporaryDirectories } from "./test-main.js";

afterEach(stopDaemons);

/** why: A gateway URL on a port just released. Nothing listens there, so a worker's uplink dial
 * fails fast, and the fake clock never fires its retry. */
async function unreachableGatewayUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { readonly port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `ws://127.0.0.1:${port}`;
}

class DisposableFakeDriver extends FakeDriver {
  constructor(
    private readonly disposed: string[],
    options: ConstructorParameters<typeof FakeDriver>[0],
    private readonly failure?: Error,
  ) {
    super(options);
  }

  async dispose(): Promise<void> {
    this.disposed.push(this.platform);
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

async function agentStatus(daemon: DaemonServer) {
  return (await daemon.dispatch(
    "status.get",
    {},
    { manageEventSubscription: () => undefined, via: "socket", principal: "agent", role: "agent" },
  )) as { readonly host: { readonly tools: readonly unknown[] } };
}

class ToolsFakeDriver extends FakeDriver {
  constructor(
    options: ConstructorParameters<typeof FakeDriver>[0],
    private readonly tools: () => Promise<readonly DriverToolVersion[]>,
  ) {
    super(options);
  }

  toolVersions(): Promise<readonly DriverToolVersion[]> {
    return this.tools();
  }
}

describe("startDaemon", () => {
  it.each([
    { name: "not set", headers: undefined, label: undefined, expected: {} },
    {
      name: "two headers",
      headers: { "CF-Access-Client-Id": "abc.access", "CF-Access-Client-Secret": "s3cr3t" },
      label: undefined,
      expected: { "cf-access-client-id": "abc.access", "cf-access-client-secret": "s3cr3t" },
    },
    {
      name: "an empty value",
      headers: { "x-empty": "" },
      label: undefined,
      expected: { "x-empty": "" },
    },
    {
      name: "a label set too",
      headers: { "x-proxy-key": "k" },
      label: "mac-1",
      expected: { "x-proxy-key": "k" },
    },
  ])(
    "a worker started with gateway.headers sends every entry on its uplink dial, beside the join token and worker id: $name",
    async ({ headers, label, expected }) => {
      let received: IncomingHttpHeaders | undefined;
      const gateway = createHttpServer();
      gateway.on("upgrade", (request, socket) => {
        received = request.headers;
        socket.destroy();
      });
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = gateway.address() as { readonly port: number };
        await start({
          configOverrides: {
            gateway: {
              token: "join-token",
              url: `ws://127.0.0.1:${port}`,
              ...(headers === undefined ? {} : { headers }),
              ...(label === undefined ? {} : { label }),
            },
          },
        });
        await vi.waitFor(() => expect(received).toBeDefined());
        const seen = received ?? {};
        expect({
          authorization: seen["authorization"],
          workerId: typeof seen["x-simlock-worker-id"],
          label: seen["x-simlock-worker-label"],
          extra: Object.fromEntries(Object.entries(seen).filter(([name]) => name in expected)),
        }).toEqual({
          authorization: "Bearer join-token",
          workerId: "string",
          label,
          extra: expected,
        });
      } finally {
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
      }
    },
  );

  it.each([
    { role: "worker", withToken: true },
    { role: "gateway", withToken: false },
  ] as const)(
    "keeps gateway.token and every gateway.headers value out of the daemon log, the events.replay answer, and history.db, while config.get returns them only as the redaction marker unless showSecrets is asked: $role",
    async ({ role, withToken }) => {
      const secret = "secret-join-token-170";
      const headerSecret = "s3cr3t-proxy-credential";
      const secondHeaderSecret = "second-proxy-credential";
      const { daemon, directory, sink } = await start({
        role,
        configOverrides: {
          gateway: {
            headers: {
              "CF-Access-Client-Id": "client-id-170",
              "CF-Access-Client-Secret": headerSecret,
              "X-Proxy-Key": secondHeaderSecret,
            },
            ...(withToken ? { token: secret, url: await unreachableGatewayUrl() } : {}),
          },
        },
      });
      const admin = {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "operator",
        role: "admin",
      } as const;
      type Answer = {
        readonly gateway: {
          readonly token?: string;
          readonly headers?: Readonly<Record<string, string>>;
        };
      };

      const replayed = await daemon.dispatch("events.replay", {}, admin);
      const eventFile = JSON.stringify(
        await historyEventsWhen(directory, hasEvent("daemon.started")),
      );
      const config = (await daemon.dispatch("config.get", {}, admin)) as Answer;

      // why: The fixture is real: the daemon did log its start and emit `daemon.started` to both
      // the ring and the file, so "absent" below means redacted, not never written.
      expect(sink.records.some((record) => record.message === "Daemon started")).toBe(true);
      expect(eventFile).toContain('"daemon.started"');
      expect(JSON.stringify(replayed)).toContain('"daemon.started"');
      const leaks = (value: string) => ({
        daemonLog: JSON.stringify(sink.records).includes(value),
        eventsReplay: JSON.stringify(replayed).includes(value),
        historyDb: eventFile.includes(value),
      });
      const clean = { daemonLog: false, eventsReplay: false, historyDb: false };
      expect({
        token: leaks(secret),
        header: leaks(headerSecret),
        second: leaks(secondHeaderSecret),
        first: leaks("client-id-170"),
      }).toEqual({
        token: clean,
        header: clean,
        second: clean,
        first: clean,
      });
      const shown = (await daemon.dispatch("config.get", { showSecrets: true }, admin)) as Answer;
      expect({
        default: config.gateway.headers,
        shown: shown.gateway.headers,
        token: [config.gateway.token, shown.gateway.token],
      }).toEqual({
        default: {
          "CF-Access-Client-Id": "[redacted]",
          "CF-Access-Client-Secret": "[redacted]",
          "X-Proxy-Key": "[redacted]",
        },
        shown: {
          "CF-Access-Client-Id": "client-id-170",
          "CF-Access-Client-Secret": headerSecret,
          "X-Proxy-Key": secondHeaderSecret,
        },
        token: withToken ? ["[redacted]", secret] : [undefined, undefined],
      });
    },
  );

  it.each([
    {
      name: "nothing set: each driver's own defaults",
      drivers: {},
      expected: (home: string) => ({
        android: { adbServerPort: 5038, deviceRoot: join(home, "devices", "android") },
        ios: { deviceRoot: join(home, "devices", "ios"), deviceSet: "simlock" },
      }),
    },
    {
      name: "set keys win over the defaults, and a driver's unknown key is carried",
      drivers: { android: { adbServerPort: 5039 }, ios: { deviceSet: "simlock", retries: 3 } },
      expected: (home: string) => ({
        android: { adbServerPort: 5039, deviceRoot: join(home, "devices", "android") },
        ios: { deviceRoot: join(home, "devices", "ios"), deviceSet: "simlock", retries: 3 },
      }),
    },
    {
      name: "deviceSet default: no iOS deviceRoot, which that set does not use",
      drivers: { ios: { deviceSet: "default" } },
      expected: (home: string) => ({
        android: { adbServerPort: 5038, deviceRoot: join(home, "devices", "android") },
        ios: { deviceSet: "default" },
      }),
    },
  ])(
    "answers config.get with every drivers.* key the drivers use, so config get reads it back ($name)",
    async ({ drivers, expected }) => {
      const { daemon, directory } = await start({ configOverrides: { drivers } });

      const config = (await daemon.dispatch(
        "config.get",
        {},
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "operator",
          role: "admin",
        },
      )) as { readonly drivers?: unknown };

      expect(config.drivers).toEqual(expected(directory));
    },
  );

  it("keeps gateway.token in the daemon.started payload and the Daemon started log line as the redaction marker, so a set token still reads as set", async () => {
    const { daemon, sink } = await start({
      configOverrides: {
        gateway: { token: "secret-join-token-170", url: await unreachableGatewayUrl() },
      },
    });
    const replayed = (await daemon.dispatch(
      "events.replay",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "operator",
        role: "admin",
      },
    )) as readonly { readonly event: string; readonly payload: unknown }[];

    const started = replayed.find((envelope) => envelope.event === "daemon.started");
    const logged = sink.records.find((record) => record.message === "Daemon started");
    const snapshot = (started?.payload as { readonly configSnapshot?: Config } | undefined)
      ?.configSnapshot;
    const loggedConfig = logged?.fields?.config as Config | undefined;
    expect({
      eventToken: snapshot?.gateway.token,
      logToken: loggedConfig?.gateway.token,
    }).toEqual({ eventToken: REDACTED_VALUE, logToken: REDACTED_VALUE });
  });

  it("runs no prerequisite check at startup convergence, and runs every check on each doctor.run", async () => {
    const runs = { android: 0, ios: 0 };
    const missing = { message: "gone", prerequisite: "android-emulator", remedy: "install it" };
    const { daemon } = await start({
      prerequisiteChecks: [
        {
          check: () => {
            runs.ios += 1;
            return Promise.resolve([]);
          },
          platform: "ios",
        },
        {
          check: () => {
            runs.android += 1;
            return Promise.resolve([missing]);
          },
          platform: "android",
        },
      ],
    });
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;

    // why: doctor.run parks until startup convergence has finished, so by the time it answers,
    // convergence's own reconcile has run -- and must not have counted.
    const first = (await daemon.dispatch("doctor.run", {}, admin)) as {
      readonly findings: readonly { readonly kind: string; readonly prerequisite?: string }[];
    };
    expect(runs).toEqual({ android: 1, ios: 1 });
    expect(first.findings).toContainEqual(
      expect.objectContaining({ kind: "prerequisite-missing", platform: "android" }),
    );

    await daemon.dispatch("doctor.run", {}, admin);
    expect(runs).toEqual({ android: 2, ios: 2 });
  });

  it("a worker's doctor reports service-broken for each service whose paths are gone", async () => {
    const gone = "/Users/me/.nvm/versions/node/v22.13.0/bin/node";
    const mainGone = "/Users/me/simlock/dist/daemon/main.js";
    const name = "com.callstack.simlock.worker";
    const remedy = "Run `simlock daemon install` again.";
    const admin = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "operator",
      role: "admin",
    } as const;
    for (const testCase of [
      { label: "not installed", missing: [], expected: [] },
      { label: "installed and whole", missing: [], expected: [] },
      {
        label: "one path gone",
        missing: [gone],
        expected: [{ kind: "service-broken", manager: "launchd", name, missing: [gone], remedy }],
      },
      {
        label: "both gone",
        missing: [gone, mainGone],
        expected: [
          { kind: "service-broken", manager: "launchd", name, missing: [gone, mainGone], remedy },
        ],
      },
    ]) {
      const { daemon } = await start({
        serviceCheck: { manager: "launchd", name, check: async () => testCase.missing },
      });
      const report = (await daemon.dispatch("doctor.run", {}, admin)) as {
        readonly findings: readonly { readonly kind: string }[];
      };
      expect(
        report.findings.filter((finding) => finding.kind === "service-broken"),
        testCase.label,
      ).toEqual(testCase.expected);
    }
  });

  it("productionServiceCheck on Windows reads the task: the path it names that is gone, none when all are there or there is no task, and no check on a gateway", async () => {
    const name = "com.callstack.simlock.worker";
    const query = {
      command: "cmd.exe",
      args: ["/d", "/c", `chcp 65001 >nul && schtasks /query /tn ${name} /xml`],
    };
    const xml = `<Task><Settings><Enabled>true</Enabled></Settings><Exec><Arguments>--headless "/gone/node.exe" "/here/service-main.js" --task ${name}</Arguments></Exec></Task>`;
    const cases = [
      {
        label: "path gone",
        result: { code: 0, stdout: xml, stderr: "" },
        files: ["/here/service-main.js"],
        missing: ["/gone/node.exe"],
      },
      {
        label: "no task",
        result: { code: 1, stdout: "", stderr: "ERROR" },
        files: [],
        missing: [],
      },
    ];
    for (const { label, result, files, missing } of cases) {
      const filesystem = new MemoryFilesystem();
      await filesystem.mkdirp("/here");
      for (const file of files) await filesystem.writeFileAtomic(file, "");
      const runner = new ScriptedProcessRunner([{ match: query, result }]);
      const host = {
        manager: new TaskSchedulerServiceManager({ runner, filesystem }),
        // why: the default root is join(home, ".simlock"); on Windows join uses backslashes, and any other root gets a hash suffix on the task name.
        root: join("/Users/me", ".simlock"),
        home: "/Users/me",
        nodePath: "/gone/node.exe",
        mainPath: "/here/main.js",
        env: {},
      };
      const { serviceCheck } = productionServiceCheck("worker", host);
      expect(serviceCheck?.manager, label).toBe("task-scheduler");
      expect(await serviceCheck?.check(), label).toEqual(missing);
      expect(productionServiceCheck("gateway", host), label).toEqual({});
    }
  });

  it("productionServiceCheck builds the service definition from the process facts and reads its state: the missing paths when broken, none otherwise, and no check on a gateway or without a manager", async () => {
    const seen: ServiceDefinition[] = [];
    const manager: ServiceManager = {
      manager: "launchd",
      state: async (definition) => {
        seen.push(definition);
        return { state: "broken", path: definition.path, missing: [definition.command] };
      },
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
    };
    // why: the service name is the plain one when the root is `join(home, ".simlock")`, which is `\` on Windows.
    const root = join("/Users/me", ".simlock");
    const host = {
      manager,
      root,
      home: "/Users/me",
      nodePath: "/gone/node",
      mainPath: "/gone/main.js",
      env: { PATH: "/usr/bin" },
    };

    const { serviceCheck } = productionServiceCheck("worker", host);

    expect(serviceCheck?.name).toBe("com.callstack.simlock.worker");
    expect(await serviceCheck?.check()).toEqual(["/gone/node"]);
    expect(seen).toEqual([
      serviceDefinition({
        role: "worker",
        root,
        dataDirectory: daemonDataDirectory(root, "worker"),
        home: "/Users/me",
        nodePath: "/gone/node",
        mainPath: "/gone/main.js",
        env: { PATH: "/usr/bin" },
      }),
    ]);
    expect(productionServiceCheck("gateway", host)).toEqual({});
    expect(productionServiceCheck("worker", { ...host, manager: undefined })).toEqual({});

    const states: readonly { readonly state: ServiceState; readonly missing: readonly string[] }[] =
      [
        { state: { state: "not-installed" }, missing: [] },
        { state: { state: "installed", path: "/p" }, missing: [] },
        { state: { state: "not-loaded", path: "/p" }, missing: [] },
        {
          state: { state: "broken", path: "/p", missing: ["/gone/node", "/gone/main.js"] },
          missing: ["/gone/node", "/gone/main.js"],
        },
      ];
    for (const testCase of states) {
      const checked = productionServiceCheck("worker", {
        ...host,
        manager: new FakeServiceManager({ state: testCase.state }),
      });
      expect(checked.serviceCheck?.manager).toBe("launchd");
      expect(checked.serviceCheck?.name).toBe("com.callstack.simlock.worker");
      expect(await checked.serviceCheck?.check(), testCase.state.state).toEqual(testCase.missing);
    }
    expect(
      productionServiceCheck("worker", {
        ...host,
        manager: new FakeServiceManager({ manager: "systemd" }),
      }).serviceCheck?.manager,
    ).toBe("systemd");

    const systemd = productionServiceCheck("worker", {
      ...host,
      manager: { ...manager, manager: "systemd" },
      home: "/home/me",
      root: join("/home/me", ".simlock"),
    });
    await systemd.serviceCheck?.check();
    expect(seen.at(-1)?.path).toBe(
      join("/home/me", ".config", "systemd", "user", "com.callstack.simlock.worker.service"),
    );
  });

  it("stores lease requests under the configured limits, with failures classified by contract code", async () => {
    const { daemon, directory } = await start({
      configOverrides: { lease: { maxRequestRecords: 1 } },
    });
    const missingRuntime = {
      model: "iPhone 16",
      osVersion: "99.0",
      platform: "ios",
    } as const;
    const session = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "agent",
      role: "agent",
    } as const;

    for (const requesterId of ["first", "second"]) {
      await daemon
        .dispatch("lease.request", { ...missingRuntime, requesterId }, session)
        .catch(() => undefined);
    }

    await expect
      .poll(() => queryState(directory, "SELECT requester_id, failure_code FROM lease_requests"))
      .toEqual([{ failure_code: "RUNTIME_MISSING", requester_id: "second" }]);
  });

  it("a started worker refuses an iOS lease in a mode its ios.modes leaves out", async () => {
    const clock = new FakeClock(1_000);
    const { daemon } = await start({
      clock,
      configOverrides: { ios: { modes: ["slim"] } },
      drivers: [new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" })],
    });
    const session = {
      manageEventSubscription: () => undefined,
      via: "socket",
      principal: "agent",
      role: "agent",
    } as const;

    await expect(
      daemon.dispatch(
        "lease.request",
        { mode: "full", model: "iPhone 16", osVersion: "26.5", platform: "ios" },
        session,
      ),
    ).rejects.toMatchObject({ code: "MODE_UNAVAILABLE" });
  });

  it("establishes the instance identity once, and reuses it on the next start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-main-identity-"));
    temporaryDirectories.push(directory);
    const filesystem = new MemoryFilesystem();
    const identityPath = join(directory, "instance.json");

    const first = await start({ dataDirectory: directory, filesystem });
    const written = JSON.parse(await filesystem.readFile(identityPath)) as {
      readonly instanceId: string;
    };
    await first.daemon.stop("test");
    await start({ dataDirectory: directory, filesystem });

    // why: Never regenerated: a second id would strand every device already sitting in a root
    // marked with the first one (ADR 0001, decision 2).
    expect(written.instanceId).not.toBe("");
    expect(JSON.parse(await filesystem.readFile(identityPath))).toEqual(written);
  });

  it("disposes every driver on shutdown, and reports the one that failed without stopping", async () => {
    // why: The wiring, not the halves: `DaemonServer` awaiting its `dispose` option is tested in
    // `server.test.ts` and a driver reaping its adb server in the Android driver's own, and
    // between them sat the composition that connects the two. Losing it silently abandons
    // Simlock's adb server on every shutdown, and only `Driver.dispose` can stop one.
    const disposed: string[] = [];
    const clock = new FakeClock(1_000);
    const { daemon, sink } = await start({
      drivers: [
        new DisposableFakeDriver(disposed, {
          availableOsVersions: ["26.5"],
          clock,
          platform: "ios",
        }),
        new DisposableFakeDriver(
          disposed,
          { availableOsVersions: ["35"], clock, platform: "android" },
          new Error("adb server would not die"),
        ),
      ],
      deviceDataTables: fakeDeviceDataTables,
    });

    await daemon.stop("test");

    expect(disposed).toEqual(["ios", "android"]);
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Driver disposal failed",
        fields: expect.objectContaining({ platform: "android" }),
      }),
    );
  });

  it("ends a running component install on shutdown, before the drivers are disposed", async () => {
    const clock = new FakeClock(1_000);
    const events: string[] = [];
    class InstallingDriver extends FakeDriver {
      override async installComponent(
        component: string,
        options: Parameters<FakeDriver["installComponent"]>[1],
      ) {
        events.push("install-started");
        options.signal.addEventListener("abort", () => events.push("install-ended"));
        return super.installComponent(component, options);
      }

      async dispose(): Promise<void> {
        events.push("disposed");
      }
    }
    const driver = new InstallingDriver({ availableOsVersions: [], clock, platform: "ios" });
    driver.holdInstalls();
    const { daemon } = await start({ drivers: [driver] });

    const lease = daemon
      .dispatch(
        "lease.request",
        {
          allowDownload: true,
          model: "iPhone 16",
          osVersion: "26.5",
          platform: "ios",
        },
        {
          manageEventSubscription: () => undefined,
          via: "socket",
          principal: "agent",
          role: "agent",
        },
      )
      .catch((error: unknown) => error);
    await expect.poll(() => events).toEqual(["install-started"]);
    await daemon.stop("test");

    expect(events).toEqual(["install-started", "install-ended", "disposed"]);
    await expect(lease).resolves.toBeInstanceOf(Error);
  });

  it("ends a running seed settle on shutdown and waits for the driver to return, before the drivers are disposed", async () => {
    const clock = new FakeClock(1_000);
    const events: string[] = [];
    class SettlingDriver extends FakeDriver {
      override async listSources() {
        return [
          {
            id: "quick",
            kind: "seed" as const,
            leases: 2,
            model: "iPhone 17",
            osVersion: "26.5",
            settled: false,
          },
        ];
      }

      settleSeed(_sourceId: string, options: { readonly signal: AbortSignal }) {
        events.push("settle-started");
        return new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              events.push("settle-aborted");
              // why: a timer, not a microtask, so the driver returns after every
              // await the dispose chain makes unless it waits for the settle.
              setTimeout(() => {
                events.push("settle-returned");
                reject(new Error("aborted"));
              }, 50);
            },
            { once: true },
          );
        });
      }

      async dispose(): Promise<void> {
        events.push("disposed");
      }
    }
    const driver = new SettlingDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    const { daemon } = await start({ clock, drivers: [driver] });

    clock.advance(5 * 60_000);
    await expect.poll(() => events).toEqual(["settle-started"]);
    await daemon.stop("test");

    expect(events).toEqual(["settle-started", "settle-aborted", "settle-returned", "disposed"]);
  });

  it("starts and reports no entry for a driver whose tool read fails, and every other tool", async () => {
    const clock = new FakeClock(1_000);
    const { daemon } = await start({
      drivers: [
        new ToolsFakeDriver(
          { availableOsVersions: ["26.5"], clock, platform: "ios" },
          // why: What an iOS driver whose `xcodebuild` fails looks like from here.
          () => Promise.reject(new Error("xcodebuild -version exited with 1")),
        ),
        new ToolsFakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }, () =>
          Promise.resolve([{ name: "emulator", version: "35.4.9" }]),
        ),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    await expect
      .poll(async () => (await agentStatus(daemon)).host)
      .toEqual({
        arch: "arm64",
        os: "macOS",
        osVersion: "15.5",
        tools: [{ name: "emulator", platform: "android", version: "35.4.9" }],
      });
  });

  it("answers status.get when a driver reports a tool version past the contract's bounds", async () => {
    const clock = new FakeClock(1_000);
    const { daemon } = await start({
      drivers: [
        new ToolsFakeDriver({ availableOsVersions: ["35"], clock, platform: "android" }, () =>
          Promise.resolve([
            { name: "emulator", version: "9".repeat(500) },
            { name: "platform-tools", version: "36.0.0" },
          ]),
        ),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    await expect
      .poll(async () => (await agentStatus(daemon)).host.tools)
      .toEqual([{ name: "platform-tools", platform: "android", version: "36.0.0" }]);
  });

  it("reads tool versions at start, before anything asks for status", async () => {
    const clock = new FakeClock(1_000);
    let reads = 0;
    await start({
      drivers: [
        new ToolsFakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" }, () => {
          reads += 1;
          return Promise.resolve([]);
        }),
      ],
      deviceDataTables: fakeDeviceDataTables,
      hostInfo: new FakeHostInfo({ arch: "arm64", os: "macOS", osVersion: "15.5" }),
    });

    expect(reads).toBe(1);
  });

  it("still answers component.list when a driver's component listing fails", async () => {
    const clock = new FakeClock(1_000);
    const ios = new FakeDriver({ availableOsVersions: ["26.5"], clock, platform: "ios" });
    ios.failOn("listComponents", 1, new Error("simctl runtime list failed"));
    const { daemon } = await start({ drivers: [ios] });

    const listed = await daemon.dispatch(
      "component.list",
      {},
      {
        manageEventSubscription: () => undefined,
        via: "socket",
        principal: "agent",
        role: "agent",
      },
    );

    expect(listed).toEqual({ components: [] });
  });
});
