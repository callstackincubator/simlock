import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentDeviceModuleWith, FakeAgentDevice } from "../agent-device/testing.js";
import { readHistoryEvents } from "../history/testing.js";
import { fakeModule } from "../modules/testing.js";
import {
  admin,
  agent,
  agentHeaders,
  daemons,
  definitions,
  directories,
  ios,
  servers,
  sleep,
  start,
} from "./test-optional-modules.js";

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test").catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("optional modules: stop hooks", () => {
  it("beforeDrain finishes before the HTTP gateway stops", async () => {
    let origin: string | undefined;
    const notes: string[] = [];
    const rig = await start(
      {
        http: true,
        modules: definitions(
          fakeModule({
            hooks: {
              beforeDrain: async () => {
                await sleep(50);
                const health = await fetch(`${origin}/v1/healthz`).then(
                  (response) => String(response.status),
                  () => "refused",
                );
                notes.push(`gateway ${health}`);
              },
            },
            name: "alpha",
          }),
        ),
        on: ["alpha"],
      },
      () => {
        notes.length = 0;
      },
    );
    origin = rig.origin;

    await rig.daemon.stop("test");

    expect(notes).toEqual(["gateway 200"]);
  });

  it("by the time the stop ends, agent-device's waiting allocate is cancelled through leasing and another module's beforeDrain has run", async () => {
    const drainRan: boolean[] = [];
    let directory = "";
    const rig = await start(
      {
        http: true,
        modules: [
          agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
          ...definitions(
            fakeModule({
              hooks: {
                beforeDrain: async () => {
                  drainRan.push(true);
                },
              },
              name: "alpha",
            }),
          ),
        ],
        on: ["agent-device", "alpha"],
        phones: true,
        overrides: {
          capacity: { config: { maxRunning: 1 }, strategy: "fixed" },
        },
      },
      () => {
        drainRan.length = 0;
      },
    );
    directory = rig.directory;
    const headers = await agentHeaders(rig.daemon);
    await rig.daemon.dispatch("lease.request", ios, agent);
    const allocate = fetch(`${rig.origin}/v1/agent-device/rpc`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "agent_device.lease.allocate",
        params: {
          clientId: "client-1",
          leaseId: "2".padStart(32, "0"),
          leaseProvider: "proxy",
          platform: "ios",
          runId: "run-1",
          ttlMs: 120_000,
        },
      }),
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    }).catch(() => undefined);
    await vi.waitFor(async () =>
      expect(
        ((await rig.daemon.dispatch("list.get", { kind: "requests" }, admin)) as unknown[]).length,
      ).toBe(1),
    );

    await rig.daemon.stop("test");
    await allocate;

    const history = await readHistoryEvents(directory);
    const cancelled = history.filter(
      (event) =>
        event.event === "lease.rejected" && JSON.stringify(event.payload).includes('"cancelled"'),
    );
    expect(drainRan).toEqual([true]);
    expect(cancelled).toHaveLength(1);
  });

  it("beforeDriversDispose finishes before the driver's dispose starts", async () => {
    const notes: string[] = [];
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDriversDispose: async () => {
              await sleep(30);
              notes.push("hook done");
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    await daemon.stop("test");

    expect(notes).toEqual(["hook done", "driver dispose"]);
  });

  it("with two modules whose beforeDrain hangs and settles at once, both start together; on a fake clock the step ends at 30 s, and the stop goes on", async () => {
    const started: string[] = [];
    const { clock, daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDrain: () => {
              started.push("hangs");
              return new Promise<void>(() => undefined);
            },
          },
          name: "hangs",
        }),
        fakeModule({
          hooks: {
            beforeDrain: () => {
              started.push("quick");
              return Promise.resolve();
            },
          },
          name: "quick",
        }),
      ),
      on: ["hangs", "quick"],
    });
    let stopped = false;

    const stopping = daemon.stop("test").then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect([...started].sort()).toEqual(["hangs", "quick"]));
    clock.advance(29_999);
    await sleep(30);
    const stoppedEarly = stopped;
    clock.advance(1);
    await stopping;

    expect(stoppedEarly).toBe(false);
  });

  it("a beforeDrain that throws does not keep the HTTP gateway from stopping", async () => {
    const { daemon, origin } = await start({
      http: true,
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDrain: () => Promise.reject(new Error("drain broke")),
          },
          name: "alpha",
        }),
      ),
      on: ["alpha"],
    });
    expect((await fetch(`${origin}/v1/healthz`)).status).toBe(200);

    await daemon.stop("test");
    const afterStop = await fetch(`${origin}/v1/healthz`).then(
      () => "answered",
      () => "refused",
    );

    expect(afterStop).toBe("refused");
  });

  it("a beforeDriversDispose that throws does not keep the drivers from being disposed", async () => {
    const notes: string[] = [];
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: { beforeDriversDispose: () => Promise.reject(new Error("dispose broke")) },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    await daemon.stop("test");

    expect(notes).toContain("driver dispose");
  });

  it("a beforeDriversDispose that runs past 30 s on a fake clock does not keep the drivers from being disposed", async () => {
    const notes: string[] = [];
    const { clock, daemon } = await start({
      modules: definitions(
        fakeModule({
          hooks: {
            beforeDriversDispose: () => {
              notes.push("hook started");
              return new Promise<void>(() => undefined);
            },
          },
          name: "alpha",
        }),
      ),
      notes,
      on: ["alpha"],
    });

    const stopping = daemon.stop("test");
    await vi.waitFor(() => expect(notes).toContain("hook started"));
    clock.advance(29_999);
    await sleep(30);
    expect(notes).not.toContain("driver dispose");
    clock.advance(1);
    await stopping;

    expect(notes).toContain("driver dispose");
  });
});
