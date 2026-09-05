import { describe, expect, it } from "vitest";

import { OPERATIONS, type OperationName } from "../src/contract/index.js";
import { NodeIpcTransport } from "../src/ports/index.js";
import { SimlockWire, WireCallError } from "../src/simlock-client/wire.js";
import { withDaemon } from "./helpers/index.js";

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

  it("answers every operation it declares, rather than falling through to UNKNOWN_REQUEST", async () => {
    const env = await withDaemon();
    // The sweep talks to the daemon directly, so nothing here would start one implicitly the
    // way `env.cli` does.
    expect((await env.startDaemon()).code).toBe(0);

    // The real client transport, not a hand-rolled one: `SimlockWire.call` takes the
    // operation name as a plain string, which is exactly what a sweep over the registry
    // needs and what the typed `SimlockClient` facade deliberately does not expose.
    const wire = new SimlockWire(await new NodeIpcTransport().connect(env.socketPath));
    try {
      await wire.hello({ principal: "contract-surface-agent" });

      const probed = Object.keys(OPERATIONS).filter(
        (name) => !INTERCEPTED.has(name),
      ) as OperationName[];
      // Guards the guard: if `INTERCEPTED` ever swallowed the registry, the loop below
      // would pass by doing nothing at all.
      expect(probed.length).toBeGreaterThan(15);

      const answers = await Promise.all(
        probed.map(async (name) => {
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

      // Asserted as one object rather than per operation so a failure names every
      // unreachable operation at once, instead of stopping at the first.
      expect(Object.fromEntries(answers)).toEqual(
        Object.fromEntries(probed.map((name) => [name, "BAD_REQUEST"])),
      );
    } finally {
      await wire.close();
    }
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
