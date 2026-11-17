import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
import { FakeFarm, type FarmAnswer } from "./test-remote.js";

const URL = "https://farm.example.com";
const AGENT_A = { SIMLOCK_AGENT_ID: "agent-a", SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };

const farmAnswers: Record<string, FarmAnswer> = {
  "lease.release": (payload) => ({ leaseId: (payload as { leaseId: string }).leaseId }),
  "lease.renew": () => detachedGrant.lease,
  "lease.request": () => detachedGrant,
};

interface Held {
  readonly clock: FakeClock;
  readonly farm: FakeFarm;
  readonly finished: Promise<number>;
  readonly signals: EventEmitter;
  stderr(): string;
}

function holdRemoteLease(answers: Record<string, FarmAnswer> = {}): Held {
  const clock = new FakeClock(0);
  const farm = new FakeFarm({ ...farmAnswers, ...answers });
  const signals = new EventEmitter();
  const output = outputCapture({ ...realCliEnvironmentPorts(), clock }, AGENT_A);
  const environment = output.environmentWith({
    signals: signals as unknown as ReturnType<typeof output.environmentWith>["signals"],
    webSocket: farm,
  });
  return {
    clock,
    farm,
    finished: runCli(["lease", "--platform", "ios"], environment),
    signals,
    stderr: () => output.stderr,
  };
}

const notice = (text: string) => `{"notice":"${text}"}`;

describe("CLI: a held remote lease across a network drop", () => {
  it("reconnects after a drop before the lease's deadline, renews, and holds on", async () => {
    const held = holdRemoteLease();
    await vi.waitFor(() => expect(held.farm.requestTypes()).toEqual(["lease.request"]));

    held.farm.connections[0]?.peer.dropped(1006, "");
    await vi.waitFor(() => expect(held.stderr()).toContain("lost the connection"));
    expect(held.stderr().trim()).toBe(
      notice(
        `lost the connection to ${URL}; reconnecting until 1970-01-01T00:01:01.000Z to keep lease lse_env`,
      ),
    );

    held.clock.advance(1_000);
    await vi.waitFor(() => expect(held.stderr()).toContain("reconnected"));
    expect(held.stderr().trim().split("\n").at(-1)).toBe(
      notice(`reconnected to ${URL}; lease lse_env renewed`),
    );
    expect(held.farm.requestTypes()).toEqual(["lease.request", "lease.renew"]);

    held.signals.emit("SIGINT");
    expect(await held.finished).toBe(0);
    expect(held.farm.requestTypes()).toEqual(["lease.request", "lease.renew", "lease.release"]);
  });
});
