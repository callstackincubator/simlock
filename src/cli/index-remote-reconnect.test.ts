import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../ports/index.js";
import { runCli } from "./index.js";
import { detachedGrant, outputCapture, realCliEnvironmentPorts, settle } from "./test-index.js";
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
  readonly attempts: number[];
  stderr(): string;
}

function holdRemoteLease(answers: Record<string, FarmAnswer> = {}): Held {
  const clock = new FakeClock(0);
  const farm = new FakeFarm({ ...farmAnswers, ...answers });
  const signals = new EventEmitter();
  const output = outputCapture({ ...realCliEnvironmentPorts(), clock }, AGENT_A);
  const attempts: number[] = [];
  const connect = farm.connect.bind(farm);
  farm.connect = (...args) => {
    attempts.push(clock.now());
    return connect(...args);
  };
  const environment = output.environmentWith({
    signals: signals as unknown as ReturnType<typeof output.environmentWith>["signals"],
    webSocket: farm,
  });
  return {
    attempts,
    clock,
    farm,
    finished: runCli(["lease", "--platform", "ios"], environment),
    signals,
    stderr: () => output.stderr,
  };
}

const notice = (text: string) => `{"notice":"${text}"}`;

async function rideOutADropBeforeTheDeadline(): Promise<void> {
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
}

async function neverBackBeforeTheDeadline(): Promise<void> {
  const held = holdRemoteLease();
  await vi.waitFor(() => expect(held.farm.requestTypes()).toEqual(["lease.request"]));
  held.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(held.stderr()).toContain("lost the connection"));
  held.farm.failure = new Error("connect ECONNREFUSED");
  held.attempts.length = 0;

  const steps = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];
  for (const [tried, step] of steps.entries()) {
    held.clock.advance(step);
    await vi.waitFor(() => expect(held.attempts).toHaveLength(tried + 1));
    await settle();
  }
  expect(held.attempts).toEqual([1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);

  held.clock.advance(1_000);
  expect(await held.finished).toBe(14);
  expect(held.stderr()).toContain('"push":"lease-lost"');
  held.clock.advance(120_000);
  expect(held.attempts).toHaveLength(7);
}

describe("CLI: a held remote lease across a network drop", () => {
  it("rides out a drop: it reconnects and renews until the lease's deadline, and ends with the lease lost when the farm never comes back", async () => {
    await rideOutADropBeforeTheDeadline();
    await neverBackBeforeTheDeadline();
  });
});
