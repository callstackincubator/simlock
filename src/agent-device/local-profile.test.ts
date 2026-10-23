import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, fakeDeviceDataTables } from "../core/testing.js";
import { startDaemon, type StartDaemonOptions } from "../daemon/main.js";
import type { DaemonServer } from "../daemon/server.js";
import { FakeClock, JsonLinesLogger, MemoryFilesystem, MemoryLogSink } from "../ports/index.js";
import { seedTokensDatabase } from "../auth/testing.js";
import { agentDeviceModuleWith, FakeAgentDevice } from "./testing.js";

const runningDaemons: DaemonServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningDaemons.splice(0).map((daemon) => daemon.stop("test")));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const LABEL = "agent-device on this Mac";
const adminSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "admin",
  role: "admin",
} as const;

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port bound");
  return address.port;
}

interface Rig {
  readonly daemon: DaemonServer;
  readonly filesystem: MemoryFilesystem;
  readonly logs: MemoryLogSink;
  readonly profilePath: string;
  readonly port: number;
  readonly restart: (options?: Switches & { readonly port?: number }) => Promise<Rig>;
}

interface Switches {
  readonly http?: boolean;
  readonly agentDevice?: boolean;
  readonly role?: "gateway";
  readonly defaults?: "standalone" | "joined";
}

interface LaunchOptions extends Switches {
  readonly refuseWrite?: boolean;
  readonly host?: string;
  readonly seed?: Parameters<typeof seedTokensDatabase>[1];
  readonly port?: number;
  readonly resume?: { readonly directory: string; readonly filesystem: MemoryFilesystem };
}

async function dataDirectoryFor(
  options: LaunchOptions,
): Promise<{ directory: string; filesystem: MemoryFilesystem }> {
  if (options.resume !== undefined) return options.resume;
  const directory = await mkdtemp(join(tmpdir(), "simlock-local-profile-"));
  temporaryDirectories.push(directory);
  await seedTokensDatabase(directory, options.seed ?? []);
  return { directory, filesystem: new MemoryFilesystem() };
}

async function launch(options: LaunchOptions = {}): Promise<Rig> {
  const host = options.host ?? "127.0.0.1";
  const { directory, filesystem } = await dataDirectoryFor(options);
  const clock = new FakeClock(1_000);
  const logs = new MemoryLogSink();
  const port = options.port ?? (await freeLoopbackPort());
  if (options.refuseWrite === true) {
    filesystem.defineFailure(join(directory, "agent-device-profile.json"), "EACCES");
  }
  const daemon = await startDaemon({
    clock,
    configOverrides:
      options.defaults === undefined
        ? {
            capabilities: { "agent-device": { enabled: options.agentDevice ?? true } },
            http: { enabled: options.http ?? true, host, port },
          }
        : {
            capabilities: { "agent-device": { command: "fake-agent-device" } },
            ...(options.defaults === "joined"
              ? {
                  gateway: {
                    token: "slk_join",
                    url: `ws://127.0.0.1:${String(await freeLoopbackPort())}`,
                  },
                }
              : {}),
            http: { port },
          },
    ...(options.role === undefined ? {} : { role: options.role }),
    dataDirectory: directory,
    deviceDataTables: fakeDeviceDataTables,
    drivers: [
      new FakeDriver({
        availableOsVersions: ["26.5"],
        clock,
        defaultModels: { phone: ["iPhone 16"] },
        knownModels: ["iPhone 16"],
        modelClasses: { "iPhone 16": "phone" },
        platform: "ios",
      }),
    ],
    filesystem,
    logger: new JsonLinesLogger({ clock, level: "debug", sink: logs }),
    optionalModules: [agentDeviceModuleWith({ upstream: new FakeAgentDevice() })],
    version: "1.2.3",
  } as StartDaemonOptions);
  runningDaemons.push(daemon);
  return {
    daemon,
    filesystem,
    logs,
    port,
    profilePath: join(directory, "agent-device-profile.json"),
    restart: async (restartOptions = {}) => {
      await daemon.stop("test");
      return launch({
        host,
        ...restartOptions,
        port: restartOptions.port ?? port,
        resume: { directory, filesystem },
      });
    },
  };
}

async function tokens(rig: Rig) {
  return (await rig.daemon.dispatch("token.list", {}, adminSession)).tokens;
}

function allocateWith(rig: Rig, secret: string, n: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${rig.port}/v1/agent-device/rpc`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "agent_device.lease.allocate",
      params: {
        clientId: "c",
        leaseId: n.toString(16).padStart(32, "0"),
        leaseProvider: "proxy",
        platform: "ios",
        runId: "r",
        ttlMs: 120_000,
      },
    }),
    headers: {
      authorization: `Bearer ${secret}`,
      connection: "close",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function listens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// why: holds the profile write open so a test can look at the HTTP port while the profile is not yet on disk.
class HoldingFilesystem extends MemoryFilesystem {
  readonly reached: Promise<void>;
  release: () => void = () => undefined;
  private markReached: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor() {
    super();
    this.reached = new Promise((resolve) => {
      this.markReached = resolve;
    });
  }

  override async writeFileAtomic(
    ...args: Parameters<MemoryFilesystem["writeFileAtomic"]>
  ): Promise<void> {
    if (args[0].endsWith("agent-device-profile.json")) {
      this.markReached();
      await this.released;
    }
    return super.writeFileAtomic(...args);
  }

  override async writeFileExclusive(
    ...args: Parameters<MemoryFilesystem["writeFileExclusive"]>
  ): Promise<void> {
    if (args[0].endsWith("agent-device-profile.json")) {
      this.markReached();
      await this.released;
    }
    return super.writeFileExclusive(...args);
  }
}

describe("the local agent-device profile", () => {
  it("is on disk before the HTTP listener accepts a connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-local-profile-"));
    temporaryDirectories.push(directory);
    await seedTokensDatabase(directory, []);
    const filesystem = new HoldingFilesystem();
    const port = await freeLoopbackPort();

    const starting = launch({ port, resume: { directory, filesystem } });
    await filesystem.reached;
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await listens(port), "HTTP listens while the profile is still being written").toBe(
        false,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    filesystem.release();
    const rig = await starting;

    expect(await filesystem.readFile(rig.profilePath)).toContain("daemonAuthToken");
    expect(await listens(port)).toBe(true);
  });

  it("is written with the contract keys, and its token leases for a local agent", async () => {
    const rig = await launch({ seed: [["tok_operator", "slk_operator", "operator", LABEL]] });

    const text = await rig.filesystem.readFile(rig.profilePath);
    const profile = JSON.parse(text) as Record<string, string>;
    expect((await rig.filesystem.stat(rig.profilePath)).mode).toBe(0o600);
    expect(Object.keys(profile)).toEqual([
      "clientId",
      "daemonAuthToken",
      "daemonBaseUrl",
      "daemonTransport",
      "leaseProvider",
      "runId",
      "sessionIsolation",
      "tenant",
    ]);
    expect(text).toBe(`${JSON.stringify(profile, null, 2)}\n`);
    expect(profile).toMatchObject({
      clientId: "a51a51a51a51a51a",
      daemonBaseUrl: `http://127.0.0.1:${rig.port}/v1/agent-device`,
      daemonTransport: "http",
      leaseProvider: "proxy",
      runId: "simlock-local",
      sessionIsolation: "tenant",
      tenant: "local",
    });
    const labelled = (await tokens(rig)).filter((token) => token.label === LABEL);
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.role).toBe("agent");
    expect(labelled[0]?.id).not.toBe("tok_operator");

    const response = await allocateWith(rig, profile.daemonAuthToken ?? "", 1);
    expect(((await response.json()) as { result: unknown }).result).toMatchObject({ ok: true });
    const leases = (await rig.daemon.dispatch(
      "list.get",
      { kind: "leases" },
      adminSession,
    )) as never as {
      ownerId: string;
    }[];
    expect(leases.map((lease) => lease.ownerId)).toEqual([labelled[0]?.id]);

    const bases = [
      ["0.0.0.0", "http://127.0.0.1"],
      ["::", "http://127.0.0.1"],
      ["::1", "http://[::1]"],
    ] as const;
    for (const [host, origin] of bases) {
      const other = await launch({ host });
      const written = JSON.parse(await other.filesystem.readFile(other.profilePath)) as {
        daemonBaseUrl: string;
      };
      expect(written.daemonBaseUrl, host).toBe(`${origin}:${other.port}/v1/agent-device`);
    }
  });

  it("keeps the profile across a restart, and replaces a token that no longer verifies", async () => {
    const readProfile = async (rig: Rig) => {
      const text = await rig.filesystem.readFile(rig.profilePath);
      return {
        profile: JSON.parse(text) as { daemonAuthToken: string; daemonBaseUrl: string },
        text,
      };
    };
    const labelledIds = async (rig: Rig) =>
      (await tokens(rig)).filter((token) => token.label === LABEL).map((token) => token.id);

    const first = await launch();
    const before = await readProfile(first);
    const [tokenId] = await labelledIds(first);
    await first.daemon.dispatch("token.create", { label: LABEL, role: "operator" }, adminSession);
    expect(await labelledIds(first)).toHaveLength(2);

    const identity = (await first.filesystem.stat(first.profilePath)).identity;
    const same = await first.restart();
    expect((await readProfile(same)).text).toBe(before.text);
    expect((await same.filesystem.stat(same.profilePath)).identity).toBe(identity);
    expect(await labelledIds(same)).toEqual([tokenId]);

    const port = await freeLoopbackPort();
    const moved = await same.restart({ port });
    const after = await readProfile(moved);
    expect(after.profile.daemonBaseUrl).toBe(`http://127.0.0.1:${port}/v1/agent-device`);
    expect(after.profile.daemonAuthToken).toBe(before.profile.daemonAuthToken);
    expect(await labelledIds(moved)).toEqual([tokenId]);

    const breakers: [string, (rig: Rig) => Promise<void>][] = [
      [
        "revoked",
        async (rig) => {
          await rig.daemon.dispatch("token.revoke", { id: tokenId ?? "" }, adminSession);
        },
      ],
      ["deleted", (rig) => rig.filesystem.rm(rig.profilePath)],
      ["not JSON", (rig) => rig.filesystem.writeFileAtomic(rig.profilePath, "not json")],
      [
        "unlabelled",
        async (rig) => {
          const made = await rig.daemon.dispatch("token.create", { role: "agent" }, adminSession);
          await rig.filesystem.writeFileAtomic(
            rig.profilePath,
            JSON.stringify({ daemonAuthToken: made.secret }),
          );
        },
      ],
    ];
    let current = moved;
    for (const [name, breakIt] of breakers) {
      const lastToken = (await readProfile(current)).profile.daemonAuthToken;
      await current.daemon.dispatch("token.create", { label: LABEL, role: "agent" }, adminSession);
      await breakIt(current);
      current = await current.restart();
      const replaced = await readProfile(current);
      const ids = await labelledIds(current);
      expect(ids, name).toHaveLength(1);
      expect(replaced.profile.daemonAuthToken, name).not.toBe(lastToken);
      expect(ids[0], name).not.toBe(tokenId);
      expect((await allocateWith(current, replaced.profile.daemonAuthToken, 2)).status, name).toBe(
        200,
      );
    }
  });

  it("is withdrawn where it does not apply: HTTP off, agent-device off, a gateway", async () => {
    const withdrawals: [string, Switches][] = [
      ["HTTP off", { http: false }],
      ["agent-device off", { agentDevice: false }],
    ];
    for (const [name, off] of withdrawals) {
      const on = await launch();
      expect(await on.filesystem.exists(on.profilePath), name).toBe(true);

      const withdrawn = await on.restart(off);

      expect(await withdrawn.filesystem.exists(withdrawn.profilePath), name).toBe(false);
      expect(
        (await tokens(withdrawn)).filter((token) => token.label === LABEL),
        name,
      ).toEqual([]);
    }

    const gateway = await launch({ role: "gateway" });
    expect(await gateway.filesystem.exists(gateway.profilePath)).toBe(false);
  });

  it("does not stop the worker when the profile cannot be written, and logs one warning", async () => {
    const rig = await launch({ refuseWrite: true });

    const warnings = rig.logs.records.filter((record) =>
      record.message.startsWith("Could not prepare"),
    );
    expect(warnings.map((record) => [record.level, record.message])).toEqual([
      [
        "warn",
        `Could not prepare the agent-device profile: Injected EACCES failure: ${rig.profilePath}`,
      ],
    ]);
    const made = await rig.daemon.dispatch("token.create", { role: "agent" }, adminSession);
    expect((await allocateWith(rig, made.secret, 1)).status).toBe(200);
  });

  it("is written and served by a standalone worker on its defaults, and not by a joined one", async () => {
    const standalone = await launch({ defaults: "standalone" });
    const config = await standalone.daemon.dispatch("config.get", {}, adminSession);
    expect(config.http.enabled).toBe(true);
    expect(config.capabilities["agent-device"]?.enabled).toBe(true);
    const profile = JSON.parse(await standalone.filesystem.readFile(standalone.profilePath)) as {
      daemonAuthToken: string;
    };
    const health = await fetch(`http://127.0.0.1:${standalone.port}/v1/agent-device/health`, {
      headers: { authorization: `Bearer ${profile.daemonAuthToken}`, connection: "close" },
    });
    const joined = await launch({ defaults: "joined" });

    expect(health.status).toBe(200);
    expect(await listens(joined.port)).toBe(false);
    expect(await joined.filesystem.exists(joined.profilePath)).toBe(false);
    expect((await joined.daemon.dispatch("status.get", {}, adminSession)).capabilities).toEqual([
      { name: "agent-device", state: "off" },
    ]);
  });
});
