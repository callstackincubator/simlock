import { describe, expect, it } from "vitest";

import { GATEWAY_ONLY_OPERATIONS, OPERATIONS, type OperationName } from "../src/contract/index.js";
import { NodeIpcTransport } from "../src/ports/index.js";
import { SimlockWire, WireCallError } from "../src/simlock-client/wire.js";
import { freeLoopbackPort, withDaemon } from "./helpers/index.js";
import type { TestEnv } from "./helpers/env.js";

/**
 * The contract's own surface, checked against a daemon that is actually running.
 *
 * Every other flow in this suite drives one feature through the CLI. This one asks a
 * different question: is each operation the contract *declares* reachable at all? Nothing
 * else answers it. `docs/adr/0003` §2 splits an operation across three places -- the
 * `OPERATIONS` registry, a `case` in `DaemonServer`'s hand-written socket switch, and a
 * handler in the `Dispatcher` -- and only the last of those is checked by the compiler.
 * A declaration whose switch case was never written falls through to `default:` and
 * answers `UNKNOWN_REQUEST`, which reads to a caller exactly like an out-of-date daemon.
 *
 * That is not hypothetical: `driver.passthrough` shipped declared, dispatched by the CLI
 * and implemented nowhere, so every `simlock simctl` / `simlock adb` answered
 * `UNKNOWN_REQUEST`. The per-feature flows caught it for that one operation; this catches
 * the shape of the mistake for all of them, including operations added later.
 */
describe("contract surface", () => {
  /**
   * Deliberately excluded, not forgotten. `daemon.stop` is ADR §6's frozen exception:
   * `DaemonServer#dispatchLine` intercepts it ahead of the protocol-version and `#stopping`
   * gates, so it never reaches the switch this sweep is probing -- and probing it would
   * stop the daemon out from under the rest of the sweep.
   */
  const INTERCEPTED: ReadonlySet<string> = new Set(["daemon.stop"]);

  /**
   * A payload no operation's input schema can accept: every one of them is a `z.object`,
   * and a bare string is not an object.
   *
   * Probing with an *invalid* payload is what makes this sweep safe to run against every
   * operation indiscriminately. Validation happens before the role check, the `authorize`
   * hook and the handler (ADR §2's ordering), so a well-formed-but-unauthorized probe would
   * tell us less, and a *valid* one would run `nuke.run` and `lease.release-all` for real.
   * Reaching `BAD_REQUEST` proves the request was routed to an operation that then parsed
   * it -- which is the whole question here. What the handler would have done with a good
   * payload is every other flow's business.
   */
  const UNPARSEABLE_PAYLOAD = "not-an-object";

  /** Every operation this sweep probes: the registry minus the one the transport intercepts. */
  function probedOperations(): OperationName[] {
    const probed = Object.keys(OPERATIONS).filter(
      (name) => !INTERCEPTED.has(name),
    ) as OperationName[];
    // Guards the guard: if `INTERCEPTED` ever swallowed the registry, a sweep would pass by
    // doing nothing at all.
    expect(probed.length).toBeGreaterThan(15);
    return probed;
  }

  /** The code each operation answers an unparseable payload with, keyed by operation. */
  async function sweep(env: TestEnv): Promise<Record<string, string>> {
    // The real client transport, not a hand-rolled one: `SimlockWire.call` takes the
    // operation name as a plain string, which is exactly what a sweep over the registry
    // needs and what the typed `SimlockClient` facade deliberately does not expose.
    const wire = new SimlockWire(await new NodeIpcTransport().connect(env.socketPath));
    try {
      await wire.hello({ principal: "contract-surface-agent" });
      const answers = await Promise.all(
        probedOperations().map(async (name) => {
          try {
            await wire.call(name, UNPARSEABLE_PAYLOAD);
            return [name, "accepted an unparseable payload"] as const;
          } catch (error: unknown) {
            return [
              name,
              error instanceof WireCallError ? error.code : `threw ${String(error)}`,
            ] as const;
          }
        }),
      );
      return Object.fromEntries(answers);
    } finally {
      await wire.close();
    }
  }

  it("answers every operation it declares, rather than falling through to UNKNOWN_REQUEST", async () => {
    const env = await withDaemon();
    // The sweep talks to the daemon directly, so nothing here would start one implicitly the
    // way `env.cli` does.
    expect((await env.startDaemon()).code).toBe(0);

    // Asserted as one object rather than per operation so a failure names every unreachable
    // operation at once, instead of stopping at the first. The gateway-only operations
    // (ADR 0005 §23) are the one deliberate exception: a worker has no worker registry, so
    // `UNKNOWN_REQUEST` -- "this daemon does not implement that operation" -- is the honest
    // answer rather than a routing mistake. The gateway's own sweep below is what proves they
    // are reachable somewhere.
    expect(await sweep(env)).toEqual(
      Object.fromEntries(
        probedOperations().map((name) => [
          name,
          (GATEWAY_ONLY_OPERATIONS as readonly string[]).includes(name)
            ? "UNKNOWN_REQUEST"
            : "BAD_REQUEST",
        ]),
      ),
    );
  });

  it("answers every operation on a gateway too, including the ones it refuses", async () => {
    // ADR 0005 §32: the gateway is a second implementation of the same contract, reached
    // through the same socket switch -- so it needs the same sweep. Every operation must parse
    // its input before deciding anything, so even the ones a gateway answers
    // `UNSUPPORTED_IN_GATEWAY_MODE` reject an unparseable payload with `BAD_REQUEST` first.
    // Anything that came back `UNKNOWN_REQUEST` here would be an operation a gateway forgot.
    const port = await freeLoopbackPort();
    const env = await withDaemon({
      configOverrides: { http: { host: "127.0.0.1", port }, mode: "gateway" },
      driver: "none",
    });
    expect((await env.startDaemon()).code).toBe(0);

    expect(await sweep(env)).toEqual(
      Object.fromEntries(probedOperations().map((name) => [name, "BAD_REQUEST"])),
    );
  });

  /**
   * The other half: `UNKNOWN_REQUEST` still has to be what an *undeclared* operation gets.
   * Without this, the assertion above could be satisfied by a daemon that had stopped
   * rejecting anything -- and a client asking for an operation its newer version knows
   * about needs that code to tell "your daemon is older than you" from "you sent junk".
   */
  it("still refuses an operation the contract does not declare", async () => {
    const env = await withDaemon();
    expect((await env.startDaemon()).code).toBe(0);

    const wire = new SimlockWire(await new NodeIpcTransport().connect(env.socketPath));
    try {
      await wire.hello({ principal: "contract-surface-agent" });

      const refusal = await wire
        .call("lease.teleport", {})
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(WireCallError);
      expect((refusal as WireCallError).code).toBe("UNKNOWN_REQUEST");
    } finally {
      await wire.close();
    }
  });
});
