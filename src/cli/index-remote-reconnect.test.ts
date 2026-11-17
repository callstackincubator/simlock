import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeClock, WebSocketRefusedError } from "../ports/index.js";
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
  exitCode(): number | undefined;
  readonly signals: EventEmitter;
  readonly attempts: number[];
  stderr(): string;
}

function holdRemoteLease(
  answersFor: (clock: FakeClock) => Record<string, FarmAnswer> = () => ({}),
): Held {
  const clock = new FakeClock(0);
  const farm = new FakeFarm({ ...farmAnswers, ...answersFor(clock) });
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
  let exitCode: number | undefined;
  void runCli(["lease", "--platform", "ios"], environment).then((code) => (exitCode = code));
  return {
    attempts,
    clock,
    exitCode: () => exitCode,
    farm,
    signals,
    stderr: () => output.stderr,
  };
}

async function ends(held: Held): Promise<number> {
  await vi.waitFor(() => expect(held.exitCode(), "the command ends").toBeDefined());
  return held.exitCode() as number;
}

const notice = (text: string) => `{"notice":"${text}"}`;

const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

const errorLine = (stderr: string) =>
  (
    JSON.parse(stderr.trim().split("\n").at(-1) as string) as {
      error: { code: string; message: string };
    }
  ).error;

async function dropped(held: Held, code = 1006): Promise<void> {
  await vi.waitFor(() => expect(held.farm.requestTypes()).toEqual(["lease.request"]));
  held.farm.connections[0]?.peer.dropped(code, "");
}

async function advanceThroughTries(held: Held, steps: readonly number[]): Promise<void> {
  const before = held.attempts.length;
  for (const [tried, step] of steps.entries()) {
    held.clock.advance(step);
    await vi.waitFor(() => expect(held.attempts).toHaveLength(before + tried + 1));
    await settle();
  }
}

async function reconnectAnswersDecideTheEnd(): Promise<void> {
  const gone = holdRemoteLease(() => ({ "lease.renew": () => fault("UNKNOWN_LEASE", "gone") }));
  await dropped(gone);
  await vi.waitFor(() => expect(gone.stderr()).toContain("lost the connection"));
  gone.clock.advance(1_000);
  expect(await ends(gone)).toBe(14);
  expect(gone.stderr()).toContain('"push":"lease-lost"');

  const unreachableFor50s = holdRemoteLease((clock) => ({
    "lease.renew": () =>
      clock.now() < 50_000
        ? fault("WORKER_UNREACHABLE", "the worker is not answering")
        : { ...detachedGrant.lease, ttlDeadline: clock.now() + 60_000 },
  }));
  await dropped(unreachableFor50s);
  await vi.waitFor(() => expect(unreachableFor50s.stderr()).toContain("lost the connection"));
  await advanceThroughTries(
    unreachableFor50s,
    [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000],
  );
  await vi.waitFor(() => expect(unreachableFor50s.stderr()).toContain("reconnected"));
  unreachableFor50s.signals.emit("SIGINT");
  expect(await ends(unreachableFor50s)).toBe(0);
  expect(unreachableFor50s.farm.requestTypes().at(-1)).toBe("lease.release");

  const refusals: [string, (held: Held) => void, Record<string, FarmAnswer>][] = [
    ["UNAUTHENTICATED", (held) => (held.farm.failure = new WebSocketRefusedError(401, "")), {}],
    [
      "PROTOCOL_VERSION_UNSUPPORTED",
      () => undefined,
      { "lease.renew": () => fault("PROTOCOL_VERSION_UNSUPPORTED", "too old") },
    ],
  ];
  for (const [name, refuse, answers] of refusals) {
    const held = holdRemoteLease(() => answers);
    await dropped(held);
    await vi.waitFor(() => expect(held.stderr()).toContain("lost the connection"));
    refuse(held);
    held.clock.advance(1_000);
    expect(await ends(held), name).toBe(1);
    const line = errorLine(held.stderr());
    expect(line.code).toBe(name);
    expect(line.message, name).toContain("lease lse_env is still yours until");
    held.clock.advance(120_000);
    expect(held.attempts, name).toHaveLength(2);
    expect(held.stderr(), name).not.toContain("lease-lost");
  }
  const revoked = holdRemoteLease();
  await dropped(revoked, 4003);
  expect(await ends(revoked)).toBe(1);
  expect(errorLine(revoked.stderr()).code).toBe("UNAUTHENTICATED");
  expect(revoked.attempts).toHaveLength(1);
}

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
  expect(await ends(held)).toBe(0);
  expect(held.farm.requestTypes()).toEqual(["lease.request", "lease.renew", "lease.release"]);
}

async function neverBackBeforeTheDeadline(): Promise<void> {
  const held = holdRemoteLease();
  await vi.waitFor(() => expect(held.farm.requestTypes()).toEqual(["lease.request"]));
  held.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(held.stderr()).toContain("lost the connection"));
  held.farm.failure = new Error("connect ECONNREFUSED");
  held.attempts.length = 0;

  await advanceThroughTries(held, [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  expect(held.attempts).toEqual([1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000]);

  held.clock.advance(1_000);
  expect(await ends(held)).toBe(14);
  expect(held.stderr()).toContain('"push":"lease-lost"');
  held.clock.advance(120_000);
  expect(held.attempts).toHaveLength(7);
}

describe("CLI: a held remote lease across a network drop", () => {
  it("rides out a drop: it reconnects and renews until the lease's deadline, and ends with the lease lost when the farm never comes back", async () => {
    await rideOutADropBeforeTheDeadline();
    await neverBackBeforeTheDeadline();
    await reconnectAnswersDecideTheEnd();
  });
});
