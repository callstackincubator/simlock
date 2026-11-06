import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
import {
  FakeNpmCli,
  FakeUpdaterLauncher,
  NodeFilesystem,
  NodeIpcTransport,
  type NpmOutcome,
} from "../ports/index.js";
import { createDaemonProbe } from "../updater/index.js";
import { connectSimlockClient } from "../simlock-client/client.js";
import {
  type ServerFrame,
  createClient,
  createClientRetrying,
  createHarness,
  deferred,
  hello,
  leaseIdOf,
  stopTestDaemons,
} from "./test-server.js";

afterEach(stopTestDaemons);

describe("daemon.update", () => {
  interface RigSetup {
    readonly version?: string;
    readonly view?: NpmOutcome;
    readonly launcher?: FakeUpdaterLauncher;
    readonly packageRoot?: string;
    readonly otherRoleRunning?: boolean;
    readonly npm?: FakeNpmCli;
    readonly lease?: { readonly defaultTtlMs: number };
  }
  async function updateRig(leases: number, devices = 2, setup: RigSetup = {}) {
    const npm =
      setup.npm ??
      new FakeNpmCli({
        view: [setup.view ?? { ok: true, output: "0.4.0" }],
        globalRoot: [{ ok: true, output: "/opt" }],
      });
    const launcher = setup.launcher ?? new FakeUpdaterLauncher();
    const harness = await createHarness({
      iosMaxDevices: devices,
      ...(setup.lease === undefined ? {} : { lease: setup.lease }),
      update: {
        npm,
        launcher,
        version: setup.version ?? "0.3.0",
        ...(setup.packageRoot === undefined ? {} : { packageRoot: setup.packageRoot }),
        ...(setup.otherRoleRunning === undefined
          ? {}
          : { otherRoleRunning: setup.otherRoleRunning }),
      },
    });
    const client = await createClient(harness.socketPath);
    await hello(client);
    const leaseIds: string[] = [];
    for (let index = 0; index < leases; index += 1) {
      const grant = await client.request("lease.request", {
        requesterId: `agent-${index}`,
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });
      leaseIds.push(leaseIdOf(grant));
    }
    const started: unknown[] = [];
    harness.eventBus.subscribe("daemon.update-started", (envelope) => {
      started.push(envelope.payload);
    });
    const updateOf = async (): Promise<unknown> =>
      ((await client.request("status.get", {})).payload as { daemon: { update: unknown } }).daemon
        .update;
    return { ...harness, client, launcher, leaseIds, npm, started, updateOf };
  }
  const run = (stage: "waiting" | "installing" | "restarting", forced: boolean, extra = {}) => ({
    stage,
    from: "0.3.0",
    to: "0.4.0",
    forced,
    startedAt: 1_000,
    ...extra,
  });

  it("starts an update that status.get shows as waiting with the lease count, then installing", async () => {
    const idle = await updateRig(0);
    await expect(idle.client.request("daemon.update", {})).resolves.toMatchObject({
      ok: true,
      payload: {
        started: true,
        upToDate: false,
        resolved: "0.4.0",
        version: "0.3.0",
        health: "running",
        update: run("installing", false),
        lastUpdateFailure: null,
        latestVersion: null,
      },
    });
    expect(await idle.updateOf()).toEqual(run("installing", false));
    expect(idle.npm.calls[0]).toEqual({ method: "view", spec: "simlock@latest" });
    expect(idle.launcher.launches).toEqual([
      {
        entry: "/opt/simlock/dist/updater/main.js",
        from: "0.3.0",
        to: "0.4.0",
        role: "worker",
        pid: 4242,
        simlockHome: "/home/simlock",
        logPath: "/data/daemon.log",
      },
    ]);
    expect(idle.started).toEqual([{ from: "0.3.0", to: "0.4.0", forced: false }]);

    const held = await updateRig(2);
    await expect(held.client.request("daemon.update", {})).resolves.toMatchObject({
      payload: { started: true, update: run("waiting", false, { leases: 2 }) },
    });
    expect(await held.updateOf()).toEqual(run("waiting", false, { leases: 2 }));
    expect(held.launcher.launches).toEqual([]);
    await held.client.request("lease.release", { leaseId: held.leaseIds[0] });
    await expect.poll(held.updateOf).toEqual(run("waiting", false, { leases: 1 }));
    expect(held.launcher.launches).toEqual([]);
    await held.client.request("lease.release", { leaseId: held.leaseIds[1] });
    await expect.poll(held.updateOf).toEqual(run("installing", false));
    expect(held.launcher.launches).toHaveLength(1);

    const expiring = await updateRig(1, 2, { lease: { defaultTtlMs: 40 } });
    await expiring.client.request("daemon.update", {});
    expect(await expiring.updateOf()).toEqual(run("waiting", false, { leases: 1 }));
    expiring.clock.advance(40);
    await expect.poll(expiring.updateOf).toEqual(run("installing", false));
    expect(expiring.launcher.launches).toHaveLength(1);

    const forced = await updateRig(2);
    await expect(forced.client.request("daemon.update", { force: true })).resolves.toMatchObject({
      payload: { started: true, update: run("installing", true) },
    });
    expect(forced.launcher.launches).toHaveLength(1);
    expect(forced.started).toEqual([{ from: "0.3.0", to: "0.4.0", forced: true }]);
    expect(forced.registry.snapshot.leases).toHaveLength(2);

    const waiting = await updateRig(2);
    await waiting.client.request("daemon.update", {});
    expect(await waiting.updateOf()).toEqual(run("waiting", false, { leases: 2 }));
    await expect(waiting.client.request("daemon.update", { force: true })).resolves.toMatchObject({
      payload: { started: false, update: run("installing", true) },
    });
    expect(waiting.launcher.launches).toHaveLength(1);
    expect(waiting.started).toEqual([{ from: "0.3.0", to: "0.4.0", forced: false }]);

    const converge = deferred<void>();
    const npm = new FakeNpmCli({
      view: [{ ok: true, output: "0.4.0" }],
      globalRoot: [{ ok: true, output: "/opt" }],
    });
    const launcher = new FakeUpdaterLauncher();
    const starting = await createHarness({
      converge: () => converge.promise,
      start: false,
      update: { npm, launcher, version: "0.3.0" },
    });
    const startPromise = starting.daemon.start();
    const client = await createClientRetrying(starting.socketPath);
    await hello(client);
    const parked = client.request("daemon.update", {});
    await expect(client.request("status.get", {})).resolves.toMatchObject({ ok: true });
    expect(npm.calls).toEqual([]);
    converge.resolve();
    await startPromise;
    await expect(parked).resolves.toMatchObject({
      payload: { started: true, update: run("installing", false) },
    });
  });

  it("follows the update that runs whatever version a call names, and answers a query without starting anything", async () => {
    const idle = await updateRig(0);
    await expect(idle.client.request("daemon.update", { query: true })).resolves.toMatchObject({
      ok: true,
      payload: { started: false, upToDate: false, resolved: null, version: "0.3.0", update: null },
    });
    expect(idle.npm.calls).toEqual([]);
    expect(idle.launcher.launches).toEqual([]);

    const rig = await updateRig(2);
    await rig.client.request("daemon.update", {});
    const following = { started: false, upToDate: false, resolved: null };
    for (const input of [{ query: true }, { version: "0.9.9" }, {}]) {
      await expect(rig.client.request("daemon.update", input)).resolves.toMatchObject({
        ok: true,
        payload: { ...following, update: run("waiting", false, { leases: 2 }) },
      });
    }
    expect(rig.npm.calls.filter((call) => call.method === "view")).toHaveLength(1);
    expect(rig.launcher.launches).toEqual([]);
    expect(rig.started).toHaveLength(1);

    const gate = deferred<void>();
    class HeldNpm extends FakeNpmCli {
      override async view(spec: string) {
        await gate.promise;
        return super.view(spec);
      }
    }
    const racing = await updateRig(0, 2, {
      npm: new HeldNpm({
        view: [{ ok: true, output: "0.4.0" }],
        globalRoot: [{ ok: true, output: "/opt" }],
      }),
    });
    const other = await createClient(racing.socketPath);
    await hello(other);
    const first = racing.client.request("daemon.update", {});
    const second = other.request("daemon.update", {});
    await expect(other.request("status.get", {})).resolves.toMatchObject({ ok: true });
    gate.resolve();
    const replies = (await Promise.all([first, second])).map(
      (reply) => (reply.payload as { started: boolean }).started,
    );
    expect(replies.sort()).toEqual([false, true]);
    expect(racing.launcher.launches).toHaveLength(1);
    expect(racing.started).toHaveLength(1);
  });

  it("accepts daemon.update from an admin on a connection whose protocol range does not overlap, refuses an agent there, and lets the updater's probe read health and version through query", async () => {
    const previous = { min: PROTOCOL_VERSION_RANGE.min - 1, max: PROTOCOL_VERSION_RANGE.max - 1 };
    const mismatched = (role: "admin" | "agent") =>
      createHarness({
        protocolVersion: previous,
        resolveRole: { resolve: () => role },
        update: { npm: new FakeNpmCli(), launcher: new FakeUpdaterLauncher(), version: "0.3.0" },
      });
    const connectDegraded = (socketPath: string) =>
      connectSimlockClient({ connector: new NodeIpcTransport(), endpoint: socketPath }, true);

    const admin = await mismatched("admin");
    const client = await connectDegraded(admin.socketPath);
    await expect(client.getStatus()).rejects.toMatchObject({
      code: "PROTOCOL_VERSION_UNSUPPORTED",
    });
    await expect(client.updateDaemon({ query: true })).resolves.toMatchObject({
      started: false,
      version: "0.3.0",
      health: "running",
      update: null,
    });
    await client.close();

    const dataDirectory = dirname(admin.socketPath);
    await writeFile(join(dataDirectory, "admin.token"), "token\n");
    const probe = createDaemonProbe({ dataDirectory, filesystem: new NodeFilesystem() });
    await expect(probe.state()).resolves.toEqual({ health: "running", version: "0.3.0" });

    const agent = await mismatched("agent");
    const refused = await connectDegraded(agent.socketPath);
    await expect(refused.updateDaemon({ query: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await refused.close();
  });

  it("follows the updater's lines in status.get, turns a failed line or a non-zero exit into lastUpdateFailure and daemon.update-failed and serves leases again, and reports a result file at start and deletes it", async () => {
    const line = (value: unknown) => JSON.stringify(value);
    const failure = (message: string, stage = "installing") => ({
      stage,
      from: "0.3.0",
      to: "0.4.0",
      message,
      at: 1_000,
    });
    const cases: readonly {
      readonly name: string;
      readonly script: { readonly lines: readonly string[]; readonly exit: number };
      readonly launcher?: FakeUpdaterLauncher;
      readonly update: unknown;
      readonly failure: ReturnType<typeof failure> | null;
    }[] = [
      {
        name: "the updater reports restarting",
        script: { lines: [line({ stage: "installing" }), line({ stage: "restarting" })], exit: 0 },
        update: run("restarting", false),
        failure: null,
      },
      {
        name: "the updater reports a failed install",
        script: {
          lines: [
            line({ stage: "installing" }),
            line({ failed: { stage: "installing", message: "npm error code EACCES" } }),
          ],
          exit: 1,
        },
        update: null,
        failure: failure("npm error code EACCES"),
      },
      {
        name: "the updater exits non-zero with no failed line",
        script: { lines: [line({ stage: "installing" })], exit: 3 },
        update: null,
        failure: failure("the updater exited with code 3"),
      },
      {
        name: "the updater exits non-zero after it reported restarting",
        script: { lines: [line({ stage: "installing" }), line({ stage: "restarting" })], exit: 2 },
        update: null,
        failure: failure("the updater exited with code 2", "restarting"),
      },
      {
        name: "the updater's failed message is longer than 2000 characters",
        script: {
          lines: [line({ failed: { stage: "installing", message: "e".repeat(3000) } })],
          exit: 1,
        },
        update: null,
        failure: failure("e".repeat(2000)),
      },
      {
        name: "the updater prints a line that is not one of its two shapes",
        script: {
          lines: [line({ stage: "restarting" }), line({ stage: "waiting" }), "not json"],
          exit: 0,
        },
        update: run("restarting", false),
        failure: null,
      },
      {
        name: "the updater cannot be started",
        script: { lines: [], exit: 0 },
        launcher: new (class extends FakeUpdaterLauncher {
          override launch(): Promise<never> {
            return Promise.reject(new Error("spawn node ENOENT"));
          }
        })(),
        update: null,
        failure: failure("spawn node ENOENT"),
      },
    ];
    for (const { name, script, launcher, update, failure: expected } of cases) {
      const rig = await updateRig(0, 2, { launcher: launcher ?? new FakeUpdaterLauncher(script) });
      const failed: unknown[] = [];
      rig.eventBus.subscribe("daemon.update-failed", (envelope) => failed.push(envelope.payload));
      await rig.client.request("daemon.update", {});
      await expect.poll(rig.updateOf, { message: name }).toEqual(update);
      const status = (await rig.client.request("status.get", {})).payload as {
        daemon: { lastUpdateFailure: unknown };
      };
      expect(status.daemon.lastUpdateFailure, name).toEqual(expected);
      expect(failed, name).toEqual(
        expected === null
          ? []
          : [
              {
                stage: expected.stage,
                from: expected.from,
                to: expected.to,
                message: expected.message,
              },
            ],
      );
      if (expected !== null) {
        await expect(
          rig.client.request("lease.request", {
            requesterId: "agent-after",
            model: "iPhone 16",
            osVersion: "26.5",
            platform: "ios",
          }),
          name,
        ).resolves.toMatchObject({ ok: true });
      }
    }

    class FailsOnce extends FakeUpdaterLauncher {
      #launched = 0;
      override async launch(...args: Parameters<FakeUpdaterLauncher["launch"]>) {
        await super.launch(...args);
        const never = new Promise<never>(() => undefined);
        return this.#launched++ === 0
          ? {
              lines: (async function* (): AsyncGenerator<string> {
                yield* [];
              })(),
              exited: Promise.resolve(1),
            }
          : {
              lines: (async function* (): AsyncGenerator<string> {
                await never;
                yield "";
              })(),
              exited: never,
            };
      }
    }
    const again = await updateRig(0, 2, { launcher: new FailsOnce() });
    await again.client.request("daemon.update", {});
    await expect
      .poll(async () => (await again.client.request("daemon.update", { query: true })).payload)
      .toMatchObject({
        update: null,
        lastUpdateFailure: { message: "the updater exited with code 1" },
      });
    await expect(again.client.request("daemon.update", {})).resolves.toMatchObject({
      payload: { started: true, update: run("installing", false), lastUpdateFailure: null },
    });

    const resultFile = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        from: "0.3.0",
        to: "0.4.0",
        stage: "restarting",
        message: "0.4.0 did not start: health failed",
        at: 500,
        rolledBack: true,
        ...overrides,
      });
    for (const { name, contents, reported } of [
      {
        name: "a result file from a rolled back update",
        contents: resultFile(),
        reported: {
          stage: "restarting",
          from: "0.3.0",
          to: "0.4.0",
          message: "0.4.0 did not start: health failed",
          at: 500,
        },
      },
      {
        name: "a result file whose message is longer than 2000 characters",
        contents: resultFile({ message: "e".repeat(3000) }),
        reported: {
          stage: "restarting",
          from: "0.3.0",
          to: "0.4.0",
          message: "e".repeat(2000),
          at: 500,
        },
      },
      { name: "a result file that is not valid", contents: "{not json", reported: null },
      {
        name: "a result file that cannot be read",
        contents: new Error("EACCES: permission denied"),
        reported: null,
      },
      {
        name: "a result file with an unknown stage",
        contents: resultFile({ stage: "waiting" }),
        reported: null,
      },
    ]) {
      const harness = await createHarness({
        update: {
          npm: new FakeNpmCli(),
          launcher: new FakeUpdaterLauncher(),
          version: "0.3.0",
          resultFile: contents,
        },
      });
      const client = await createClient(harness.socketPath);
      await hello(client);
      const status = (await client.request("status.get", {})).payload as {
        daemon: { lastUpdateFailure: unknown };
      };
      expect(status.daemon.lastUpdateFailure, name).toEqual(reported);
      expect(
        harness.eventBus
          .replay()
          .filter((envelope) => envelope.event === "daemon.update-failed")
          .map((envelope) => envelope.payload),
        name,
      ).toEqual(
        reported === null
          ? []
          : [{ stage: reported.stage, from: "0.3.0", to: "0.4.0", message: reported.message }],
      );
      expect(await harness.updateFilesystem.exists("/data/update-result.json"), name).toBe(false);
    }
  });

  it("refuses an update that cannot resolve, change or install anything, and answers upToDate when nothing is needed", async () => {
    const newerThanLatest = { version: "0.5.0-rc.1" };
    const cases: readonly {
      readonly name: string;
      readonly setup: RigSetup;
      readonly input?: Record<string, unknown>;
      readonly reply: Record<string, unknown>;
    }[] = [
      {
        name: "npm cannot resolve the version",
        setup: { view: { ok: false, message: "No match found for version 9.9.9" } },
        input: { version: "9.9.9" },
        reply: {
          ok: false,
          error: {
            code: "UPDATE_RESOLVE_FAILED",
            message: "could not resolve simlock@9.9.9: No match found for version 9.9.9",
          },
        },
      },
      {
        name: "the latest version is the running one",
        setup: { view: { ok: true, output: "0.3.0" } },
        reply: { ok: true, payload: { started: false, upToDate: true, resolved: "0.3.0" } },
      },
      {
        name: "the named version is the running one",
        setup: { view: { ok: true, output: "0.3.0" } },
        input: { version: "0.3.0" },
        reply: { ok: true, payload: { started: false, upToDate: true, resolved: "0.3.0" } },
      },
      {
        name: "the running version is newer than the latest and none was named",
        setup: newerThanLatest,
        reply: {
          ok: true,
          payload: { started: false, upToDate: true, resolved: "0.4.0", version: "0.5.0-rc.1" },
        },
      },
      {
        name: "simlock was not installed with npm",
        setup: { packageRoot: "/src/simlock" },
        reply: {
          ok: false,
          error: {
            code: "UPDATE_UNSUPPORTED_INSTALL",
            message:
              "simlock was not installed with npm i -g (found /src/simlock). Update it by hand.",
          },
        },
      },
      {
        name: "the other role's daemon of this user runs",
        setup: { otherRoleRunning: true },
        reply: {
          ok: false,
          error: {
            code: "UPDATE_SHARED_INSTALL",
            message:
              "the gateway daemon of this user runs from the same install; stop it first with simlock --gateway daemon stop",
          },
        },
      },
      ...[
        ["a query with force", { query: true, force: true }],
        ["a query with a version", { query: true, version: "0.4.0" }],
        ["a tag, not a version", { version: "latest" }],
        ["a path, not a version", { version: "../x" }],
        ["a version of 65 characters", { version: `1.0.0-${"a".repeat(59)}` }],
      ].map(([name, input]) => ({
        name: `${name as string}`,
        setup: {},
        input: input as Record<string, unknown>,
        reply: { ok: false, error: { code: "BAD_REQUEST" } },
      })),
    ];
    for (const { name, setup, input = {}, reply } of cases) {
      const rig = await updateRig(0, 2, setup);
      expect(await rig.client.request("daemon.update", input), name).toMatchObject(reply);
      expect(await rig.updateOf(), name).toBeNull();
      expect(rig.launcher.launches, name).toEqual([]);
      await expect(
        rig.client.request("lease.request", {
          requesterId: "agent-after",
          model: "iPhone 16",
          osVersion: "26.5",
          platform: "ios",
        }),
        name,
      ).resolves.toMatchObject({ ok: true });
    }

    const downgrade = await updateRig(0, 2, { ...newerThanLatest });
    await expect(
      downgrade.client.request("daemon.update", { version: "0.4.0" }),
    ).resolves.toMatchObject({ payload: { started: true, upToDate: false, resolved: "0.4.0" } });
  });

  it("refuses a new and a queued lease request with DAEMON_UPDATING while a held lease renews and releases as usual", async () => {
    const rig = await updateRig(1, 1);
    const rejected: unknown[] = [];
    rig.eventBus.subscribe("lease.rejected", (envelope) => {
      rejected.push(envelope.payload.reason);
    });
    const request = (requesterId: string) =>
      rig.client.request("lease.request", {
        requesterId,
        model: "iPhone 16",
        osVersion: "26.5",
        platform: "ios",
      });
    let queuedReply: ServerFrame | undefined;
    let newReply: ServerFrame | undefined;
    void request("agent-queued").then((reply) => (queuedReply = reply));
    await expect
      .poll(async () => (await rig.client.request("status.get", {})).payload)
      .toMatchObject({ waiting: [{ requesterId: "agent-queued" }] });
    await rig.client.request("daemon.update", {});

    const refusal = {
      ok: false,
      error: {
        code: "DAEMON_UPDATING",
        message: "this daemon is updating and takes no new leases",
      },
    };
    void request("agent-new").then((reply) => (newReply = reply));
    await expect.poll(() => queuedReply).toMatchObject(refusal);
    await expect.poll(() => newReply).toMatchObject(refusal);
    expect(rejected).toEqual(["updating", "updating"]);

    const leaseId = rig.leaseIds[0];
    await expect(rig.client.request("lease.renew", { leaseId })).resolves.toMatchObject({
      ok: true,
    });
    await expect(rig.client.request("lease.release", { leaseId })).resolves.toMatchObject({
      ok: true,
    });
    await expect.poll(rig.updateOf).toEqual(run("installing", false));
  });
});
