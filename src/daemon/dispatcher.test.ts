import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../bus/index.js";
import {
  CleanupReaper,
  Doctor,
  FakeDriver,
  LeaseEngine,
  Nuke,
  PassthroughRefusedError,
  Registry,
  type Config,
} from "../core/index.js";
import type { CatalogReader } from "../core/lease-ports.js";
import {
  CryptoTokenSecrets,
  FakeClock,
  FakeSystemStats,
  MemoryFilesystem,
  ScriptedProcessRunner,
  type ProcessRunner,
} from "../ports/index.js";
import { TokenStore } from "../http/token-store.js";
import type { DispatchSession } from "./dispatcher.js";
import { Dispatcher, DispatchError } from "./dispatcher.js";

const gibibyte = 1024 ** 3;

/**
 * ADR 0003 §12: "full contract coverage at the dispatcher: one suite ... against a fake driver
 * and a scripted session, covering parsing, role rejection, ownership, and error codes." This
 * suite drives `Dispatcher` directly -- no socket, no `DaemonServer` -- against a real
 * `LeaseEngine`/`Registry`/`CleanupReaper` backed by `FakeDriver`, the same harness style
 * `server.test.ts` uses for its own socket-level tests. It deliberately does not re-walk every
 * operation the way `server.test.ts` already does at the framing/connection level (ADR §12:
 * "re-walking every operation through each transport would test nothing new") -- this suite is
 * where the actual role/ownership/parsing logic gets proven once, not per transport.
 */
async function buildDispatcher(
  overrides: {
    readonly downloadsPolicy?: Config["downloads"]["policy"];
    readonly awaitReady?: () => Promise<void>;
    /** Overrides the `catalog` dependency -- used only to force `#parseOutput`'s failure path
     * (see "Dispatcher: #parseOutput") with a fake that returns a payload violating the
     * contract's output schema, something no real `CatalogReader` implementation would do. */
    readonly catalog?: CatalogReader;
    /** ADR §3: `nuke.run` is admin-only and destructive (`safety.md` rules 1/5). `false` by
     * default -- matching `DispatcherOptions.nuke`'s own undefined default, so most tests don't
     * pay for wiring one -- since a real `Nuke` needs this function's own `engine`/`registry`,
     * it is built here (rather than passed in) when a test opts in. */
    readonly includeNuke?: boolean;
    /** Gives the fake driver a `simlock <tool>` wrapper so `driver.passthrough` has something
     * to route to; off by default so no other test's catalog output changes shape. */
    readonly passthroughTool?: string;
    /** Narrows the lease TTL knobs (ADR 0004), for the cap and default-width rules. */
    readonly lease?: Partial<Config["lease"]>;
    /** Wires `device.exec`'s runner (ADR 0005 §19a); absent by default, like the option it
     * feeds, so no other test pays for a scripted process. */
    readonly processRunner?: ProcessRunner;
    /** Narrows `exec.timeoutMs` so the timeout path can be driven with a short clock advance
     * rather than ten minutes of one. */
    readonly exec?: Partial<Config["exec"]>;
    /** Collects the `PassthroughContext` each resolution was given, so a test can assert what
     * the driver was told about its caller (ADR 0005 §19c's "no terminal"). */
    readonly passthroughContextSink?: unknown[];
    /** Shares one clock with the test, for a flow that has to schedule against the dispatcher's
     * own timers. */
    readonly clock?: FakeClock;
  } = {},
) {
  const clock = overrides.clock ?? new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const filesystem = new MemoryFilesystem();
  const registry = await Registry.load({
    clock,
    eventBus,
    filesystem,
    idGenerator: sequence(),
    statePath: "/state.json",
  });
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    platform: "ios",
    ...(overrides.passthroughTool === undefined
      ? {}
      : {
          passthrough: (args: readonly string[], context?: unknown) => {
            overrides.passthroughContextSink?.push(context);
            // The refusal half of a real driver's passthrough, in the smallest form that
            // proves `device.exec` inherits it: `driver.passthrough` and `device.exec` call
            // this same function, so a verb refused for one is refused for the other.
            if (args.includes("delete")) {
              throw new PassthroughRefusedError(
                overrides.passthroughTool as string,
                "Refusing `simlock simctl delete`: use `simlock release` instead.",
              );
            }
            return {
              args: ["--set", "/root", ...args],
              command: overrides.passthroughTool as string,
              env: { SIMLOCK_SCOPED: "1" },
            };
          },
          passthroughTool: overrides.passthroughTool,
        }),
  });
  const config = testConfig(overrides.downloadsPolicy, overrides.lease ?? {}, overrides.exec ?? {});
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
  const reaper = new CleanupReaper({
    clock,
    config,
    eventBus,
    executor: engine.cleanup,
    filesystem,
    registry,
  });
  const doctor = new Doctor({
    claims: engine.claimReader,
    clock,
    config,
    drivers: [driver],
    eventBus,
    leaseExpirer: engine,
    quarantine: engine,
    registry,
  });
  const tokens = new TokenStore({
    clock,
    filesystem,
    idGenerator: sequence(),
    path: "/tokens.json",
    secrets: new CryptoTokenSecrets(),
  });
  const dispatcher = new Dispatcher({
    awaitReady: overrides.awaitReady ?? (() => Promise.resolve()),
    capacity: engine,
    catalog: overrides.catalog ?? engine,
    clock,
    config,
    doctor,
    eventBus,
    health: () => "running",
    leases: engine,
    ...(overrides.includeNuke === true ? { nuke: new Nuke({ executor: engine, registry }) } : {}),
    passthrough: engine,
    ...(overrides.processRunner === undefined ? {} : { processRunner: overrides.processRunner }),
    execEnv: { PATH: "/usr/bin" },
    queue: engine,
    reaper,
    registry,
    tokens,
  });
  return { clock, dispatcher, doctor, driver, engine, eventBus, registry, tokens };
}

function session(overrides: Partial<DispatchSession> = {}): DispatchSession {
  return {
    manageEventSubscription: () => undefined,
    principal: "tok_agent",
    role: "agent",
    ...overrides,
  };
}

describe("Dispatcher: parsing", () => {
  it("rejects a malformed input with BAD_REQUEST before the handler runs", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("lease.request", { platform: "ios" }, session()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a ttlMs above lease.maxTtlMs on a request, rather than clamping it", async () => {
    // ADR 0004 §4: the cap is enforced here rather than in the contract schema, because
    // `lease.maxTtlMs` is a daemon config value the contract module cannot see -- and every
    // transport reaches leases through this one dispatcher, so HTTP inherits the same answer.
    const { dispatcher } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_001 },
        session(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a ttlMs above lease.maxTtlMs on a renew too", async () => {
    const { dispatcher } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    await expect(
      dispatcher.dispatch("lease.renew", { leaseId: "lse_1", ttlMs: 1_001 }, session()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts a ttlMs at the cap on a request (ADR 0004 §4)", async () => {
    const { dispatcher } = await buildDispatcher({ lease: { maxTtlMs: 1_000 } });
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", platform: "ios", ttlMs: 1_000 },
        session(),
      ),
    ).resolves.toMatchObject({ lease: { ttlMs: 1_000 } });
  });

  it("rejects an operation this dispatcher has no handler for with UNKNOWN_REQUEST", async () => {
    const { dispatcher } = await buildDispatcher();
    // "daemon.stop" is ADR §6's frozen exception -- `DaemonServer#dispatchLine` intercepts it
    // before it ever reaches a `Dispatcher`, so this dispatcher genuinely has no handler for it.
    await expect(
      dispatcher.dispatch("daemon.stop", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ code: "UNKNOWN_REQUEST" });
  });
});

describe("Dispatcher: token.create | token.list | token.revoke", () => {
  it("creates a token, lists it, then revokes it -- admin only", async () => {
    const { dispatcher, tokens } = await buildDispatcher();
    const admin = session({ role: "admin" });

    await expect(
      dispatcher.dispatch("token.create", { role: "agent" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const created = await dispatcher.dispatch(
      "token.create",
      { role: "operator", label: "ci" },
      admin,
    );
    expect(created.token.role).toBe("operator");
    expect(created.token.label).toBe("ci");
    expect(typeof created.secret).toBe("string");

    const listed = await dispatcher.dispatch("token.list", {}, admin);
    expect(listed.tokens.map((token) => token.id)).toEqual([created.token.id]);

    const revoked = await dispatcher.dispatch("token.revoke", { id: created.token.id }, admin);
    expect(revoked.revoked).toBe(true);
    expect((await tokens.list()).length).toBe(0);
  });

  it("revoking an unknown token id returns revoked: false rather than throwing", async () => {
    const { dispatcher } = await buildDispatcher();
    const result = await dispatcher.dispatch(
      "token.revoke",
      { id: "tok_does-not-exist" },
      session({ role: "admin" }),
    );
    expect(result.revoked).toBe(false);
  });
});

describe("Dispatcher: role rejection", () => {
  it("rejects an admin-only operation from an agent session with FORBIDDEN", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("admits the same admin-only operation for an admin session", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("list.get", { kind: "devices" }, session({ role: "admin" })),
    ).resolves.toEqual([]);
  });

  // Both halves of this shipped broken once: the handler forwarded `fix` alone, so
  // `doctor --purge-orphans` prompted for confirmation and then destroyed nothing. The flag
  // stays its own all the way down -- an unattended `--fix` must not acquire a destructive
  // behaviour by upgrading (ADR 0001, decision 6) -- which is only true if it also *arrives*.
  it("doctor.run forwards purgeOrphans to the Doctor, distinctly from fix", async () => {
    const { dispatcher, doctor } = await buildDispatcher();
    const reconcile = vi.spyOn(doctor, "reconcile");

    await dispatcher.dispatch("doctor.run", {}, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({ fix: false, purgeOrphans: false });

    await dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({ fix: true, purgeOrphans: false });

    await dispatcher.dispatch("doctor.run", { purgeOrphans: true }, session({ role: "admin" }));
    expect(reconcile).toHaveBeenLastCalledWith({ fix: false, purgeOrphans: true });
  });

  // `driver.passthrough` was declared in the contract and dispatched by the socket switch while
  // no handler existed for it, which the partial handler map hid from the compiler: every
  // `simlock simctl` / `simlock adb` answered UNKNOWN_REQUEST. The map is total now, so this
  // guards the routing rather than the registration.
  it("driver.passthrough resolves the scoped command through the driver that claims the tool", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch(
        "driver.passthrough",
        { args: ["list", "devices"], tool: "simctl" },
        session(),
      ),
    ).resolves.toEqual({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      env: { SIMLOCK_SCOPED: "1" },
    });
  });

  it("driver.passthrough refuses a tool no driver claims", async () => {
    const { dispatcher } = await buildDispatcher({ passthroughTool: "simctl" });

    await expect(
      dispatcher.dispatch("driver.passthrough", { args: ["devices"], tool: "adb" }, session()),
    ).rejects.toThrow(/No driver provides a adb passthrough/);
  });

  it("doctor.run's role depends on its own input: fix:false is agent, fix:true is admin", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: false }, session({ role: "agent" })),
    ).resolves.toBeDefined();
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("doctor.run", { fix: true }, session({ role: "admin" })),
    ).resolves.toBeDefined();
  });
});

describe("Dispatcher: ownership", () => {
  async function grantLease(dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"]) {
    const grant = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    return (grant as { lease: { id: string } }).lease.id;
  }

  it("lease.renew: rejects a non-owner with FORBIDDEN, admits the owner, admin bypasses", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.renew", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ id: leaseId });
    await expect(
      dispatcher.dispatch(
        "lease.renew",
        { leaseId },
        session({ principal: "tok_other", role: "admin" }),
      ),
    ).resolves.toMatchObject({ id: leaseId });
  });

  it("lease.release: rejects a non-owner with FORBIDDEN, admits the owner", async () => {
    const { dispatcher } = await buildDispatcher();
    const leaseId = await grantLease(dispatcher);

    await expect(
      dispatcher.dispatch(
        "lease.release",
        { leaseId },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch("lease.release", { leaseId }, session({ principal: "tok_owner" })),
    ).resolves.toMatchObject({ leaseId });
  });

  it("lease.list: an agent sees only its own leases, admin sees all", async () => {
    const { dispatcher } = await buildDispatcher();
    await grantLease(dispatcher);

    const own = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_owner", role: "agent" }),
    );
    expect(own.leases).toHaveLength(1);

    const otherAgent = await dispatcher.dispatch(
      "lease.list",
      {},
      session({ principal: "tok_other", role: "agent" }),
    );
    expect(otherAgent.leases).toHaveLength(0);

    const admin = await dispatcher.dispatch("lease.list", {}, session({ role: "admin" }));
    expect(admin.leases).toHaveLength(1);
  });

  it("lease.cancel: naming a requesterId with no pending request always passes (not-found), admin bypasses too", async () => {
    const { dispatcher } = await buildDispatcher();

    // A requesterId nobody has a pending request under: not gated, since there is no owner to
    // compare against -- `pendingRequestOwner` resolves `undefined`, and `not-found` is what
    // surfaces (the same convention `ownsLease` uses for an unknown lease id).
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });

    // An omitted requesterId always passes (defaults to the principal) -- see the operation's
    // `authorize` hook doc in `operations.ts`.
    await expect(
      dispatcher.dispatch("lease.cancel", {}, session({ principal: "tok_agent", role: "agent" })),
    ).resolves.toMatchObject({ result: "not-found" });

    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "tok_other" },
        session({ principal: "tok_admin", role: "admin" }),
      ),
    ).resolves.toMatchObject({ result: "not-found" });
  });

  it("lease.cancel: gated on the pending request's recorded owner (ADR §4), not the requesterId -- so a proxy connection can cancel what it created", async () => {
    const { dispatcher, engine } = await buildDispatcher();

    // Fill iOS capacity (maxRunning: 2, see testConfig) so a third request queues instead of
    // granting immediately -- cancellability requires a still-`queued` waiter.
    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner1",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner1" }),
    );
    await dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "tok_owner2",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "tok_owner2" }),
    );

    // ADR §4's proxy case: one connection, principal "host", requesting under a different
    // requesterId ("agent-7") than its own principal.
    const queuedRequest = dispatcher.dispatch(
      "lease.request",
      {
        model: "iPhone 17 Pro",
        requesterId: "agent-7",
        osVersion: "26.5",
        platform: "ios",
      },
      session({ principal: "host" }),
    );
    await expect.poll(() => engine.queueDepth).toBe(1);

    // Naming "agent-7" from a session that is neither "host" (the recorded owner) nor admin is
    // FORBIDDEN, even though "agent-7" is the pending request's own requesterId -- the ADR
    // incoherence this fixes: `lease.cancel` is no longer gated on `requesterId === principal`.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The owning principal ("host") cancels what it created, under the requesterId it created
    // it with -- this is the case the old `requesterId === principal` comparison forbade
    // outright.
    await expect(
      dispatcher.dispatch(
        "lease.cancel",
        { requesterId: "agent-7" },
        session({ principal: "host", role: "agent" }),
      ),
    ).resolves.toMatchObject({ result: "cancelled" });

    await expect(queuedRequest).rejects.toThrow();
  });
});

// Review finding S9: `Dispatcher#leaseReleaseAll` and `#nukeRun` were exercised by no test
// anywhere (`nuke.run` appeared in `server.test.ts` only inside a comment) -- both are
// admin-only and destructive, which is exactly what `docs/agent-rules/safety.md` rules 1
// ("registry-only destruction") and 5 ("destructive CLI commands confirm or require --yes") are
// about. `--yes`/confirmation is a CLI-layer concern (not this dispatcher's), but role
// enforcement and "it actually destroys only what it should" are, and neither had coverage.
describe("Dispatcher: lease.release-all", () => {
  it("rejects an agent session with FORBIDDEN, without releasing anything", async () => {
    const { dispatcher, registry } = await buildDispatcher();
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("lease.release-all", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The lease this agent session doesn't even own must still be untouched -- a rejected
    // `lease.release-all` released nothing, it didn't just fail to report what it released.
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin releases every lease, regardless of owner, and reports every released id", async () => {
    const { dispatcher, eventBus, registry } = await buildDispatcher();
    const first = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_1" }),
    );
    const second = await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner_2" }),
    );
    expect(registry.snapshot.leases).toHaveLength(2);

    const result = await dispatcher.dispatch(
      "lease.release-all",
      {},
      session({ principal: "tok_admin", role: "admin" }),
    );

    expect(new Set(result.leaseIds)).toEqual(new Set([first.lease.id, second.lease.id]));
    expect(registry.snapshot.leases).toHaveLength(0);
    // `killed`, not `explicit`: nobody's holder asked for this (docs/EVENTS.md), and that is
    // the distinction a `lease-lost` reader acts on.
    expect(
      eventBus
        .replay()
        .filter((event) => event.event === "lease.released")
        .map((event) => (event.payload as { reason: string }).reason),
    ).toEqual(["killed", "killed"]);
  });
});

describe("Dispatcher: nuke.run", () => {
  it("rejects an agent session with FORBIDDEN, without deleting anything", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );

    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "agent" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(registry.snapshot.leases).toHaveLength(1);
  });

  it("admin can run it, releasing every lease and reporting the deleteDevices flag it ran with", async () => {
    const { dispatcher, registry } = await buildDispatcher({ includeNuke: true });
    await dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_owner" }),
    );
    expect(registry.snapshot.leases).toHaveLength(1);

    const result = await dispatcher.dispatch(
      "nuke.run",
      { deleteDevices: false },
      session({ role: "admin" }),
    );

    expect(result.releasedLeaseIds).toHaveLength(1);
    expect(registry.snapshot.leases).toHaveLength(0);
  });

  it("throws NukeUnavailableError when the dispatcher was built with no Nuke wired -- an admin cannot bypass this", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch("nuke.run", {}, session({ role: "admin" })),
    ).rejects.toMatchObject({ name: "NukeUnavailableError" });
  });
});

describe("Dispatcher: #parseOutput", () => {
  // ADR §1's central claim -- "the daemon maps its own records onto contract types in exactly
  // one place ... this is what keeps private types out of the public package surface" -- names
  // `#parseOutput` as the enforcement mechanism (see `schemas.ts`'s module doc). It had no test
  // of its own failure path: every other dispatcher test exercises a handler whose real output
  // already satisfies its schema, so `#parseOutput`'s `safeParse` always took the success
  // branch. This forces the failure branch with a `catalog: CatalogReader` fake that returns a
  // payload no real `CatalogReader` implementation would -- one that does not satisfy
  // `platformCatalogSchema` -- and checks the dispatcher does not leak that malformed payload
  // out, or the underlying zod issue detail, to the caller.
  it("fails closed with an opaque Internal error when a handler's output violates its contract schema, instead of leaking the malformed payload", async () => {
    const badCatalog: CatalogReader = {
      // `platformCatalogSchema` requires (among other fields) `platform`/`models`/`runtimes` --
      // this satisfies none of them.
      listCatalog: async () => [{ notAValidCatalogEntry: true } as never],
    };
    const { dispatcher } = await buildDispatcher({ catalog: badCatalog });

    await expect(dispatcher.dispatch("catalog.get", {}, session())).rejects.toThrow(
      /does not match its contract output schema/,
    );
    try {
      await dispatcher.dispatch("catalog.get", {}, session());
      expect.unreachable();
    } catch (error: unknown) {
      // Fails closed, generically -- not the raw zod issues (which could describe internal
      // shape) and not the malformed payload itself.
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("notAValidCatalogEntry");
    }
  });
});

describe("Dispatcher: error codes", () => {
  it("wraps a malformed request as DispatchError with the BAD_REQUEST code", async () => {
    const { dispatcher } = await buildDispatcher();
    try {
      await dispatcher.dispatch("lease.request", {}, session());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DispatchError);
      expect((error as DispatchError).code).toBe("BAD_REQUEST");
    }
  });

  it("lets a domain error (e.g. RUNTIME_MISSING) propagate untouched from the handler", async () => {
    const { dispatcher } = await buildDispatcher();
    await expect(
      dispatcher.dispatch(
        "lease.request",
        { model: "iPhone 17 Pro", osVersion: "99.0", platform: "ios" },
        session(),
      ),
    ).rejects.toMatchObject({ name: "RuntimeMissingError" });
  });
});

describe("Dispatcher: the download policy clamp applies regardless of caller", () => {
  // This is the exact behaviour ADR 0003 §2 says HTTP was missing ("the socket path applies
  // `config.downloads.policy`, HTTP passes `allowDownload` through unclamped"). Since HTTP now
  // calls this same `lease.request` handler (see `src/http/tracker.ts`), proving the clamp
  // here proves it for both frontends -- there is exactly one implementation of it left.
  it("clamps allowDownload:true to false when downloads.policy is 'never'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "never" });
    await dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const resolveCalls = driver.calls.filter((call) => call.operation === "resolveSpec");
    expect(resolveCalls.at(-1)?.arguments[1]).toMatchObject({ allowDownload: false });
  });

  it("leaves allowDownload:true untouched when downloads.policy is 'on-request'", async () => {
    const { dispatcher, driver } = await buildDispatcher({ downloadsPolicy: "on-request" });
    await dispatcher.dispatch(
      "lease.request",
      { allowDownload: true, model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session(),
    );
    const resolveCalls = driver.calls.filter((call) => call.operation === "resolveSpec");
    expect(resolveCalls.at(-1)?.arguments[1]).toMatchObject({ allowDownload: true });
  });
});

describe("Dispatcher: startup-readiness parking", () => {
  it("parks every operation but status.get on awaitReady", async () => {
    let releaseReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const { dispatcher } = await buildDispatcher({ awaitReady: () => readyPromise });

    let statusSettled = false;
    void dispatcher.dispatch("status.get", {}, session()).then(() => {
      statusSettled = true;
    });
    await flush();
    expect(statusSettled).toBe(true);

    let catalogSettled = false;
    void dispatcher.dispatch("catalog.get", {}, session()).then(() => {
      catalogSettled = true;
    });
    await flush();
    expect(catalogSettled).toBe(false);

    releaseReady();
    await flush();
    expect(catalogSettled).toBe(true);
  });
});

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await Promise.resolve();
  }
}

/**
 * ADR 0005 §19a-§19e. The operation's whole job is to run, on this machine, exactly what
 * `driver.passthrough` would have handed a caller who was already on it -- so these check the
 * two things that are genuinely new (the process and its output) and the three the operation
 * inherits and must not lose (root scoping, the refusal list, ownership).
 */
describe("Dispatcher: device.exec", () => {
  const command = { args: ["--set", "/root", "list", "devices"], command: "simctl" };

  async function withLease(overrides: Parameters<typeof buildDispatcher>[0] = {}): Promise<{
    readonly dispatcher: Awaited<ReturnType<typeof buildDispatcher>>["dispatcher"];
    readonly clock: FakeClock;
    readonly leaseId: string;
  }> {
    const built = await buildDispatcher({ passthroughTool: "simctl", ...overrides });
    const grant = await built.dispatcher.dispatch(
      "lease.request",
      { model: "iPhone 17 Pro", osVersion: "26.5", platform: "ios" },
      session({ principal: "tok_agent" }),
    );
    return {
      clock: built.clock,
      dispatcher: built.dispatcher,
      leaseId: (grant as { lease: { id: string } }).lease.id,
    };
  }

  it("runs the driver-resolved command and answers its exit code", async () => {
    const runner = new ScriptedProcessRunner([
      { match: command, result: { code: 3, stderr: "", stdout: "" } },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).resolves.toEqual({ exitCode: 3 });

    // The scoping the driver injected is on the command, and its environment is layered over
    // the daemon's own rather than replacing it -- a child given only `SIMLOCK_SCOPED` would
    // have no PATH to find `simctl` with.
    expect(runner.calls[0]).toMatchObject({
      args: ["--set", "/root", "list", "devices"],
      command: "simctl",
      options: { env: { PATH: "/usr/bin", SIMLOCK_SCOPED: "1" } },
    });
  });

  it("streams stdout and stderr chunks to the session in arrival order, unjoined", async () => {
    const runner = new ScriptedProcessRunner([
      {
        chunks: [
          { chunk: "first", stream: "stdout" },
          { chunk: "warning\n", stream: "stderr" },
          { chunk: " and second\n", stream: "stdout" },
        ],
        match: command,
      },
    ]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const seen: string[] = [];

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({
        onOutput: (stream, chunk) => {
          seen.push(`${stream}:${chunk}`);
        },
        principal: "tok_agent",
      }),
    );

    // Order across both streams, and each chunk exactly as written: a handler that buffered or
    // line-joined would show two stdout chunks merged, or stderr after both of them.
    expect(seen).toEqual(["stdout:first", "stderr:warning\n", "stdout: and second\n"]);
  });

  it("writes stdin to the child once and closes it", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, stdin: "yes\n", tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(runner.calls[0]?.options.input).toBe("yes\n");
  });

  it("kills a command that outruns exec.timeoutMs and fails with EXEC_TIMEOUT", async () => {
    const runner = new ScriptedProcessRunner([{ hangs: true, match: command }]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    clock.advance(1_000);

    // EXEC_TIMEOUT, not the exit code the kill produced: "we stopped it" and "it failed" are
    // different facts, and only the first tells a caller to raise the limit (ADR §19e).
    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("refuses a verb the driver refuses, exactly as driver.passthrough does", async () => {
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["delete", "ABCD"], leaseId, tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/Refusing/);
    // Refused before anything was spawned -- the point of the refusal list is that the command
    // never runs, not that its output is discarded.
    expect(runner.calls).toEqual([]);
  });

  /**
   * The four combinations of the operation's own hook (ADR 0005 §19b/§27), which is
   * `ownsLease` for an agent and something stricter for an admin. The lease under test was
   * granted to principal `tok_agent`, so its `ownerId` and its `requesterId` are both that.
   */
  it("gates an agent session on the lease it owns, ignoring any requesterId it sends", async () => {
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    // (1) Someone else's lease: refused -- and naming its requester does not help, because an
    // agent's `requesterId` is not read for authorization at all.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        session({ principal: "tok_other", role: "agent" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    // (2) Its own lease: allowed, and a `requesterId` naming somebody else changes nothing --
    // ignored means ignored in both directions.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        session({ principal: "tok_agent", role: "agent" }),
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it("holds an admin session to the lease's requester instead of letting it bypass", async () => {
    // This is the check a gateway's own uplink session runs against: it holds one admin
    // session and proxies many agents through it, so "admin bypasses" would let any
    // admin-role connection drive every lease on the worker (ADR 0005 §19b).
    const runner = new ScriptedProcessRunner([{ match: command }]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });
    const admin = session({ principal: "gw:instance-1", role: "admin" });

    // (3) No `requesterId`, so it defaults to the admin's own principal -- which is not who
    // the lease was granted to.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "someone-else", tool: "simctl" },
        admin,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(runner.calls).toEqual([]);

    // (4) Naming the agent it is proxying for: allowed.
    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId, requesterId: "tok_agent", tool: "simctl" },
        admin,
      ),
    ).resolves.toEqual({ exitCode: 0 });
  });

  it("refuses a tool no driver claims with UNKNOWN_PASSTHROUGH_TOOL, not BAD_REQUEST", async () => {
    // A well-formed request for a wrapper this daemon has no driver for is not a malformed
    // one -- same distinction `driver.passthrough` draws, and the same error code.
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["devices"], leaseId, tool: "adb" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/No driver provides a adb passthrough/);
    expect(runner.calls).toEqual([]);
  });

  it("tells the driver there is no terminal, so it can refuse what needs one", async () => {
    // ADR 0005 §19c: the command runs here, on pipes. The driver is the only thing that knows
    // which of its own commands that rules out (a bare `adb shell`), so the fact travels to
    // it rather than being decided here.
    const seen: unknown[] = [];
    const { dispatcher, leaseId } = await withLease({
      passthroughContextSink: seen,
      processRunner: new ScriptedProcessRunner([{ match: command }]),
    });

    await dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await dispatcher.dispatch(
      "driver.passthrough",
      { args: ["list", "devices"], tool: "simctl" },
      session({ principal: "tok_agent" }),
    );

    expect(seen).toEqual([{ hasTerminal: false }, undefined]);
  });

  it("answers UNKNOWN_LEASE for an id that names no lease, rather than running the command", async () => {
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: ["list", "devices"], leaseId: "lse_gone", tool: "simctl" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/Unknown lease: lse_gone/);
    expect(runner.calls).toEqual([]);
  });

  it("answers a tool no driver wraps with UNKNOWN_PASSTHROUGH_TOOL, not BAD_REQUEST", async () => {
    // Which wrappers exist is the drivers' answer, so `bash` is a well-formed request this
    // host cannot serve -- the same distinction, and the same code, `driver.passthrough` draws.
    const runner = new ScriptedProcessRunner([]);
    const { dispatcher, leaseId } = await withLease({ processRunner: runner });

    await expect(
      dispatcher.dispatch(
        "device.exec",
        { args: [], leaseId, tool: "bash" },
        session({ principal: "tok_agent" }),
      ),
    ).rejects.toThrow(/No driver provides a bash passthrough/);
    expect(runner.calls).toEqual([]);
  });

  it("escalates to SIGKILL when a timed-out command ignores SIGTERM", async () => {
    // SIGTERM is a request. A tool that ignores it (or is itself stuck) must not be able to
    // hold the operation -- and the caller's connection -- open past the grace window.
    const runner = new ScriptedProcessRunner([
      { hangs: true, ignoresSigterm: true, match: command },
    ]);
    const { clock, dispatcher, leaseId } = await withLease({
      exec: { timeoutMs: 1_000 },
      processRunner: runner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();
    let settled = false;
    void pending.catch(() => (settled = true));

    // The timeout fires and SIGTERM lands; the command ignores it and the operation is still
    // in flight, which is the state the escalation exists for.
    clock.advance(1_000);
    await flush();
    expect(settled).toBe(false);

    clock.advance(10_000);
    await expect(pending).rejects.toMatchObject({ code: "EXEC_TIMEOUT" });
  });

  it("does not call a command that finished a timeout, even when it exits in the timer's own turn", async () => {
    // The sharp case: the child exits at the very instant the timeout fires. A flag set by
    // whichever callback ran last would blame the limit for a command that met it, so the two
    // are raced -- whichever actually settled first is the answer. Driven by a handle whose
    // `wait()` is resolved from a timer scheduled for the same instant and registered first,
    // so the exit genuinely lands inside the timeout's own turn of the loop.
    const clock = new FakeClock(1_000);
    const handle = new SettleOnCueHandle();
    const { dispatcher, leaseId } = await withLease({
      clock,
      exec: { timeoutMs: 1_000 },
      processRunner: { spawnStreaming: () => handle } as unknown as ProcessRunner,
    });

    const pending = dispatcher.dispatch(
      "device.exec",
      { args: ["list", "devices"], leaseId, tool: "simctl" },
      session({ principal: "tok_agent" }),
    );
    await flush();

    // The child exits and the timeout fires in the same synchronous turn, with nothing having
    // observed the exit yet -- the ordering a flag would get wrong and a race gets right.
    handle.finish(7);
    clock.advance(1_000);

    await expect(pending).resolves.toEqual({ exitCode: 7 });
    // And nothing was signalled: a command that finished is not one to kill.
    expect(handle.signals).toEqual([]);
  });
});

/** A streamed child that settles only when a test says so, and records what it was signalled
 * with -- enough to tell "we killed it" from "it finished" without a real process. */
class SettleOnCueHandle {
  readonly pid = 99;
  readonly signals: string[] = [];
  #resolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly #result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      this.#resolve = resolve;
    },
  );

  finish(code: number): void {
    this.#resolve({ code, signal: null });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.signals.push(signal);
  }

  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#result;
  }
}

function sequence() {
  let next = 1;
  return { generate: () => `${next++}` };
}

function testConfig(
  downloadsPolicy: Config["downloads"]["policy"] = "on-request",
  leaseOverrides: Partial<Config["lease"]> = {},
  execOverrides: Partial<Config["exec"]> = {},
): Config {
  return {
    mode: "worker",
    gateway: { disconnectedRetentionMs: 24 * 60 * 60_000, execTimeoutMs: 11 * 60_000 },
    drivers: {},
    exec: { timeoutMs: 600_000, ...execOverrides },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    eventBuffer: { capacity: 100 },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    downloads: { policy: downloadsPolicy, acceptAndroidLicenses: false, timeoutMs: 1_200_000 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { slim: { enabled: false, bootTimeoutMs: 600_000 } },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: { defaultTtlMs: 60_000, maxTtlMs: 3_600_000, ...leaseOverrides },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 2, maxRunning: 2 },
          maxRunning: 3,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    warmPool: {
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}
