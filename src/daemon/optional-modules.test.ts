import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { agentDeviceModuleWith, FakeAgentDevice } from "../agent-device/testing.js";
import { fakeModule } from "../modules/testing.js";
import type { DaemonServer } from "./server.js";
import { openRelay, openUplink, relayInput, settleWithin } from "./test-relay-support.js";
import {
  admin,
  agent,
  agentHeaders,
  daemons,
  definitions,
  directories,
  ios,
  leaseAndRelease,
  servers,
  start,
} from "./test-optional-modules.js";

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test").catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function capabilities(daemon: DaemonServer) {
  const status = (await daemon.dispatch("status.get", {}, agent)) as {
    readonly capabilities?: readonly { name: string; state: string; reason?: string }[];
  };
  return status.capabilities ?? [];
}

describe("optional modules: turning on", () => {
  it("a module with no capabilities section, or with enabled false, is reported off in status.get, and its loadWorker is never called", async () => {
    const bare = fakeModule({ name: "alpha" });
    const disabled = fakeModule({ name: "bravo" });
    const { daemon } = await start({
      modules: definitions(bare, disabled),
      overrides: { capabilities: { bravo: { enabled: false } } },
    });

    expect(await capabilities(daemon)).toEqual(
      expect.arrayContaining([
        { name: "alpha", state: "off" },
        { name: "bravo", state: "off" },
      ]),
    );
    expect({ alpha: bare.loads, bravo: disabled.loads }).toEqual({ alpha: 0, bravo: 0 });
  });

  it("a module turned on is loaded once and reports the state its capability source answers", async () => {
    const module = fakeModule({ name: "alpha", state: "unavailable" });
    const { daemon } = await start({ modules: definitions(module), on: ["alpha"] });

    expect(await capabilities(daemon)).toContainEqual(
      expect.objectContaining({ name: "alpha", state: "unavailable" }),
    );
    expect({ loads: module.loads, creates: module.creates }).toEqual({ creates: 1, loads: 1 });
  });

  it("the capability list follows registry order, with agent-device as a registered module", async () => {
    const { daemon } = await start({
      modules: [
        ...definitions(fakeModule({ name: "zulu" })),
        agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
        ...definitions(fakeModule({ name: "alpha" })),
      ],
      on: ["zulu", "agent-device", "alpha"],
    });

    expect((await capabilities(daemon)).map((entry) => entry.name)).toEqual([
      "zulu",
      "agent-device",
      "alpha",
    ]);
  });

  it("config.get returns capabilities with each module's section", async () => {
    const { daemon } = await start({
      modules: definitions(fakeModule({ name: "alpha" })),
      on: ["alpha"],
    });

    const config = (await daemon.dispatch("config.get", {}, admin)) as {
      readonly capabilities?: unknown;
    };

    expect(config.capabilities).toEqual({ alpha: { enabled: true, greeting: "hello" } });
  });
});

describe("optional modules: worker tags", () => {
  it("status.get lists each configured tag as available after the modules, in config order", async () => {
    const alpha = { name: "alpha", state: "off" };
    const bravo = { name: "bravo", state: "available" };
    const cases: readonly {
      readonly tags: readonly string[] | undefined;
      readonly on: readonly string[];
      readonly expected: readonly unknown[];
    }[] = [
      { expected: [alpha, { name: "bravo", state: "off" }], on: [], tags: undefined },
      { expected: [alpha, { name: "bravo", state: "off" }], on: [], tags: [] },
      {
        expected: [
          alpha,
          { name: "bravo", state: "off" },
          { name: "bank-network", state: "available" },
        ],
        on: [],
        tags: ["bank-network"],
      },
      {
        expected: [
          alpha,
          bravo,
          { name: "eu-west", state: "available" },
          { name: "bank-network", state: "available" },
        ],
        on: ["bravo"],
        tags: ["eu-west", "bank-network"],
      },
    ];

    for (const { expected, on, tags } of cases) {
      const { daemon } = await start({
        modules: definitions(fakeModule({ name: "alpha" }), fakeModule({ name: "bravo" })),
        on,
        overrides: tags === undefined ? {} : { tags },
      });

      expect(await capabilities(daemon)).toEqual(expected);
    }
  });

  it("a lease whose requires names a tag is granted, and one naming a name no source has, or a module that is off, is CAPABILITY_MISSING naming only the missing names", async () => {
    const { daemon } = await start({
      modules: definitions(fakeModule({ name: "stream" })),
      overrides: { tags: ["bank-network"] },
    });
    const request = (requires: readonly string[]) =>
      daemon.dispatch("lease.request", { ...ios, requires: [...requires] }, agent);

    const grant = (await request(["bank-network"])) as { lease: { id: string } };
    await daemon.dispatch("lease.release", { leaseId: grant.lease.id }, agent);

    await expect(request(["vpn-eu"])).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: "This worker cannot serve vpn-eu",
    });
    await expect(request(["bank-network", "stream"])).rejects.toMatchObject({
      code: "CAPABILITY_MISSING",
      message: "This worker cannot serve stream",
    });
  });
});

describe("optional modules: HTTP routes", () => {
  const handler = (request: Request, identity: { readonly role: string }) =>
    Promise.resolve(Response.json({ path: new URL(request.url).pathname, role: identity.role }));

  it("a module turned on serves /v1/<name> and /v1/<name>/* through its handler, behind agent auth", async () => {
    const { daemon, origin } = await start({
      http: true,
      modules: definitions(fakeModule({ mount: () => handler, name: "alpha" })),
      on: ["alpha"],
    });
    const headers = await agentHeaders(daemon);

    const root = await fetch(`${origin}/v1/alpha`, { headers });
    const deep = await fetch(`${origin}/v1/alpha/deep/x`, { headers });
    const anonymous = await fetch(`${origin}/v1/alpha`);

    expect(await root.json()).toEqual({ path: "/v1/alpha", role: "agent" });
    expect(await deep.json()).toEqual({ path: "/v1/alpha/deep/x", role: "agent" });
    expect(anonymous.status).toBe(401);
  });

  it("a module named like a core route's first segment (status) fails the start, with HTTP off too", async () => {
    const accepted = await start({ modules: definitions(fakeModule({ name: "stat" })) });
    expect(accepted.daemon).toBeDefined();

    await expect(start({ modules: definitions(fakeModule({ name: "status" })) })).rejects.toThrow(
      "status",
    );
  });

  it("a module named like a core lease sub-route (renew, exec, rotate, files) fails the start, and POST /v1/leases/{id}/renew still renews", async () => {
    for (const name of ["renew", "exec", "rotate", "files"]) {
      await expect(start({ modules: definitions(fakeModule({ name })) })).rejects.toThrow(name);
    }

    const { daemon, origin } = await start({
      http: true,
      modules: definitions(fakeModule({ name: "alpha" })),
      on: ["alpha"],
    });
    expect(
      (await start({ modules: definitions(fakeModule({ name: "stream" })) })).daemon,
    ).toBeDefined();
    const { secret } = await daemon.dispatch(
      "token.create",
      { label: "o", role: "operator" },
      admin,
    );
    const grant = (await daemon.dispatch("lease.request", ios, agent)) as { lease: { id: string } };
    const response = await fetch(`${origin}/v1/leases/${grant.lease.id}/renew`, {
      headers: { authorization: `Bearer ${secret}` },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ leaseId: grant.lease.id });
  });

  it("with agent-device on and a fake module registered, both modules' routes and relay targets answer, and both capabilities are listed", async () => {
    const { daemon, origin } = await start({
      http: true,
      modules: [
        agentDeviceModuleWith({ upstream: new FakeAgentDevice() }),
        ...definitions(
          fakeModule({
            mount: () => handler,
            name: "alpha",
            relayTarget: () => Promise.resolve(new Response("alpha")),
          }),
        ),
      ],
      on: ["agent-device", "alpha"],
    });
    const headers = await agentHeaders(daemon);
    const uplink = await openUplink(daemon);

    const alphaRoute = await fetch(`${origin}/v1/alpha/ping`, { headers });
    const agentDeviceRoute = await fetch(`${origin}/v1/agent-device/health`, { headers });
    const alphaRelay = await openRelay(uplink, relayInput({ target: "alpha" }));
    const agentDeviceRelay = await settleWithin(
      (await openRelay(uplink, relayInput({ target: "agent-device" }))).result,
    );
    const nobodyRelay = await settleWithin(
      (await openRelay(uplink, relayInput({ target: "nobody" }))).result,
    );

    expect([alphaRoute.status, agentDeviceRoute.status]).toEqual([200, 200]);
    expect((await alphaRelay.body()).state).toBe("fulfilled");
    expect(nobodyRelay).toMatchObject({ code: "RELAY_TARGET_MISSING", state: "rejected" });
    expect(agentDeviceRelay).toMatchObject({ state: "fulfilled" });
    expect((await capabilities(daemon)).map((entry) => entry.name)).toEqual([
      "agent-device",
      "alpha",
    ]);
  });
});

describe("optional modules: relay targets", () => {
  it("a relay request to a module's name reaches its relay target with the tenant and lease id", async () => {
    const calls: { tenant: string; leaseId: string | undefined }[] = [];
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          name: "alpha",
          relayTarget: (_request, tenant, leaseId) => {
            calls.push({ leaseId, tenant });
            return Promise.resolve(new Response("from alpha"));
          },
        }),
      ),
      on: ["alpha"],
    });
    const uplink = await openUplink(daemon);

    const relay = await openRelay(
      uplink,
      relayInput({ leaseId: "lease-9", target: "alpha", tenant: "gw.g1.bob" }),
    );
    const body = await relay.body();

    expect(calls).toEqual([{ leaseId: "lease-9", tenant: "gw.g1.bob" }]);
    expect(body.state === "fulfilled" ? Buffer.from(body.value).toString() : body.state).toBe(
      "from alpha",
    );
  });

  it("a test's relayTargets option still wins over a module's relay target", async () => {
    const { daemon } = await start({
      extra: { relayTargets: { alpha: () => Promise.resolve(new Response("from the test")) } },
      modules: definitions(
        fakeModule({
          name: "alpha",
          relayTarget: () => Promise.resolve(new Response("from alpha")),
        }),
      ),
      on: ["alpha"],
    });
    const uplink = await openUplink(daemon);

    const body = await (await openRelay(uplink, relayInput({ target: "alpha" }))).body();

    expect(body.state === "fulfilled" ? Buffer.from(body.value).toString() : body.state).toBe(
      "from the test",
    );
  });
});

describe("optional modules: doctor findings", () => {
  it("a fake module's finding reaches doctor.run as module-unavailable with module, message and remedy; a second module whose findings() throws loses only its own", async () => {
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          findings: () => [{ message: "it is down", remedy: "bring it up" }],
          name: "alpha",
        }),
        fakeModule({
          findings: () => {
            throw new Error("boom");
          },
          name: "bravo",
        }),
      ),
      on: ["alpha", "bravo"],
    });

    const report = (await daemon.dispatch("doctor.run", {}, admin)) as {
      readonly findings: readonly { readonly kind: string }[];
    };

    expect(report.findings).toContainEqual({
      kind: "module-unavailable",
      message: "it is down",
      module: "alpha",
      remedy: "bring it up",
    });
    expect(report.findings.filter((finding) => finding.kind === "module-unavailable")).toHaveLength(
      1,
    );
  });
});

describe("optional modules: the context a module receives", () => {
  it("events.subscribe delivers a bus event and the module receives its config", async () => {
    const delivered: string[] = [];
    const seen: { config?: unknown } = {};
    const { daemon } = await start({
      modules: definitions(
        fakeModule({
          name: "alpha",
          onCreate: (ctx) => {
            seen.config = ctx.config;
            ctx.events.subscribe("lease.released", (envelope) => {
              delivered.push(envelope.payload.leaseId);
            });
          },
        }),
      ),
      on: ["alpha"],
    });

    const leaseId = await leaseAndRelease(daemon);

    expect(delivered).toEqual([leaseId]);
    expect(seen.config).toEqual({ greeting: "hello" });
  });
});
