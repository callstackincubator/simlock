import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeClock, WebSocketRefusedError } from "../ports/index.js";
import { RELEASE_TIMEOUT_MS } from "../lease-policy/index.js";
import { runCli } from "./index.js";
import { detachedGrant, outputCapture, realCliEnvironmentPorts, settle } from "./test-index.js";
import { FakeFarm, NO_REPLY, type FarmAnswer } from "./test-remote.js";

const URL = "https://farm.example.com";
const AGENT_A = { SIMLOCK_AGENT_ID: "agent-a", SIMLOCK_TOKEN: "slk_t", SIMLOCK_URL: URL };

const farmAnswers: Record<string, FarmAnswer> = {
  "lease.cancel": () => ({ result: "cancelled" }),
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
  stdout(): string;
}

function holdRemoteLease(
  answersFor: (clock: FakeClock) => Record<string, FarmAnswer> = () => ({}),
  extraArgv: readonly string[] = [],
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
  void runCli(["lease", "--platform", "ios", ...extraArgv], environment).then(
    (code) => (exitCode = code),
  );
  return {
    attempts,
    clock,
    exitCode: () => exitCode,
    farm,
    signals,
    stderr: () => output.stderr,
    stdout: () => output.stdout,
  };
}

async function ends(held: Held): Promise<number> {
  await vi.waitFor(() => expect(held.exitCode(), "the command ends").toBeDefined());
  return held.exitCode() as number;
}

const closedConnections = (held: Held) =>
  held.farm.connections.every(({ peer }) => peer.closedWith !== undefined);

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
  expect(
    closedConnections(unreachableFor50s),
    "a try whose renew was refused closes its connection",
  ).toBe(true);

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

async function silenceIsADropAndCtrlCWhileDisconnectedReleasesWithinABound(): Promise<void> {
  const silent = holdRemoteLease();
  await vi.waitFor(() => expect(silent.farm.requestTypes()).toEqual(["lease.request"]));
  silent.clock.advance(45_000);
  await vi.waitFor(() => expect(silent.stderr()).toContain("lost the connection"));
  silent.signals.emit("SIGINT");
  expect(await ends(silent)).toBe(0);

  const reachable = holdRemoteLease();
  await dropped(reachable);
  await vi.waitFor(() => expect(reachable.stderr()).toContain("lost the connection"));
  reachable.signals.emit("SIGINT");
  expect(await ends(reachable)).toBe(0);
  expect(reachable.farm.requestTypes()).toEqual(["lease.request", "lease.release"]);
  expect(reachable.farm.connections).toHaveLength(2);
  expect(reachable.stderr()).not.toContain("still yours");
  reachable.clock.advance(120_000);
  await settle();
  expect(reachable.farm.connections, "no reconnect timer outlives the command").toHaveLength(2);

  const refused = holdRemoteLease();
  await dropped(refused);
  await vi.waitFor(() => expect(refused.stderr()).toContain("lost the connection"));
  refused.farm.failure = new Error("connect ECONNREFUSED");
  refused.signals.emit("SIGINT");
  expect(await ends(refused)).toBe(0);
  expect(errorLine(refused.stderr()).message).toContain("lease lse_env is still yours until");

  const silentFarm = holdRemoteLease();
  await dropped(silentFarm);
  await vi.waitFor(() => expect(silentFarm.stderr()).toContain("lost the connection"));
  silentFarm.farm.unanswered = true;
  silentFarm.signals.emit("SIGINT");
  await vi.waitFor(() => expect(silentFarm.attempts.length).toBeGreaterThan(1));
  silentFarm.clock.advance(RELEASE_TIMEOUT_MS);
  expect(await ends(silentFarm)).toBe(0);
  expect(errorLine(silentFarm.stderr()).message).toContain("lease lse_env is still yours until");
  silentFarm.farm.openUnanswered();
  await settle();
  expect(closedConnections(silentFarm), "a connection that opens late is closed").toBe(true);
}

const leaseRequestsOf = (held: Held) =>
  held.farm.requests
    .filter(({ type }) => type === "lease.request")
    .map(({ payload }) => payload as { idempotencyKey?: string });

async function dropWhileRequest(held: Held): Promise<void> {
  await vi.waitFor(() => expect(leaseRequestsOf(held)).toHaveLength(1));
  held.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(held.stderr()).toContain("lost the connection"));
}

async function dropWhileQueued(): Promise<void> {
  let asked = 0;
  const queued = holdRemoteLease(() => ({
    "lease.request": () => (++asked === 1 ? NO_REPLY : detachedGrant),
  }));
  await vi.waitFor(() =>
    expect(queued.farm.requests.map(({ type }) => type)).toContain("lease.request"),
  );
  queued.farm.connections[0]?.peer.dropped(1006, "");
  await vi.waitFor(() => expect(queued.stderr()).toContain("lost the connection"));
  expect(queued.stderr().trim()).toBe(
    notice(`lost the connection to ${URL}; reconnecting to the waiting request`),
  );
  queued.clock.advance(1_000);
  await vi.waitFor(() => expect(queued.stdout()).toContain("lse_env"));
  const [first, again] = leaseRequestsOf(queued);
  expect(first?.idempotencyKey).toMatch(/\S/);
  expect(again?.idempotencyKey).toBe(first?.idempotencyKey);
  queued.signals.emit("SIGINT");
  expect(await ends(queued)).toBe(0);
}

async function ctrlCWhileReconnectingBeforeTheGrantCancelsTheRequest(): Promise<void> {
  const queued = holdRemoteLease(() => ({ "lease.request": () => NO_REPLY }));
  await dropWhileRequest(queued);
  queued.signals.emit("SIGINT");
  expect(await ends(queued)).toBe(0);
  const cancel = queued.farm.requests.find(({ type }) => type === "lease.cancel");
  expect(cancel?.payload).toEqual({ platform: "ios", requesterId: "agent-a" });
  queued.clock.advance(120_000);
  await settle();
  expect(queued.farm.connections, "no reconnect timer outlives the command").toHaveLength(2);
  expect(closedConnections(queued)).toBe(true);

  const hanging = holdRemoteLease(() => ({ "lease.request": () => NO_REPLY }));
  await dropWhileRequest(hanging);
  hanging.farm.unanswered = true;
  hanging.clock.advance(1_000);
  await vi.waitFor(() => expect(hanging.attempts.length).toBeGreaterThan(1));
  hanging.signals.emit("SIGINT");
  await settle();
  hanging.clock.advance(RELEASE_TIMEOUT_MS);
  expect(await ends(hanging)).toBe(0);
  hanging.farm.openUnanswered();
  await settle();
  await vi.waitFor(() =>
    expect(
      closedConnections(hanging),
      "connections that open after the wait ended are closed",
    ).toBe(true),
  );
}

async function queuedRequestSurvivesRestartsAndEndsWhenTheFarmStaysAway(): Promise<void> {
  const answersFor =
    (...answers: unknown[]) =>
    () => {
      let asked = 0;
      return {
        "lease.request": () => {
          asked += 1;
          return asked === 1 ? NO_REPLY : (answers[asked - 2] ?? detachedGrant);
        },
      };
    };
  const restart = fault("INTERNAL", "send it again with a new key");

  const restarted = holdRemoteLease(answersFor(restart));
  await dropWhileRequest(restarted);
  restarted.clock.advance(1_000);
  await vi.waitFor(() => expect(restarted.stdout()).toContain("lse_env"));
  expect(restarted.stderr()).toContain(
    notice(`${URL} restarted and dropped the waiting request; asking again`),
  );
  const keys = leaseRequestsOf(restarted).map((request) => request.idempotencyKey);
  expect(keys).toHaveLength(3);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  restarted.signals.emit("SIGINT");
  expect(await ends(restarted)).toBe(0);

  const twice = holdRemoteLease(answersFor(restart, restart));
  await dropWhileRequest(twice);
  twice.clock.advance(1_000);
  expect(await ends(twice)).toBe(1);
  expect(errorLine(twice.stderr()).code).toBe("INTERNAL");
  expect(leaseRequestsOf(twice)).toHaveLength(3);

  const timedOut = holdRemoteLease(
    answersFor(fault("QUEUE_TIMEOUT", "no device freed up in time")),
  );
  await dropWhileRequest(timedOut);
  timedOut.clock.advance(1_000);
  expect(await ends(timedOut)).toBe(10);
  expect(errorLine(timedOut.stderr()).code).toBe("QUEUE_TIMEOUT");

  // why: the drop comes 10 s into the wait, so a bound counted from the drop and one counted from the request end at different moments: 310 s and 40 s against 300 s and 30 s.
  for (const [argv, giveUpAt] of [
    [[], 310_000],
    [["--timeout", "30s"], 30_000],
  ] as const) {
    const gone = holdRemoteLease(answersFor(), argv);
    await vi.waitFor(() => expect(leaseRequestsOf(gone)).toHaveLength(1));
    gone.clock.advance(10_000);
    await dropWhileRequest(gone);
    gone.farm.failure = new Error("connect ECONNREFUSED");
    gone.clock.advance(giveUpAt - 1 - gone.clock.now());
    expect(gone.exitCode(), argv.join(" ")).toBeUndefined();
    gone.clock.advance(1);
    expect(await ends(gone), argv.join(" ")).toBe(1);
    expect(errorLine(gone.stderr()).code).toBe("REMOTE_UNREACHABLE");
    const tried = gone.attempts.length;
    gone.clock.advance(600_000);
    expect(gone.attempts).toHaveLength(tried);
  }
}

async function rideOutADropBeforeTheDeadline(): Promise<void> {
  const held = holdRemoteLease((clock) => ({
    "lease.renew": () => ({ ...detachedGrant.lease, ttlDeadline: clock.now() + 60_000 }),
  }));
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

  held.clock.advance(20_000);
  await vi.waitFor(() =>
    expect(held.farm.requestTypes(), "renewing resumes on the new connection").toEqual([
      "lease.request",
      "lease.renew",
      "lease.renew",
    ]),
  );

  held.signals.emit("SIGINT");
  expect(await ends(held)).toBe(0);
  expect(held.farm.requestTypes()).toEqual([
    "lease.request",
    "lease.renew",
    "lease.renew",
    "lease.release",
  ]);
  expect(closedConnections(held), "every connection is closed at the end").toBe(true);
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
  it("a held remote lease rides out a network drop: it reconnects, renews and holds on until its deadline, ends by what the farm answers, and a queued request asks again", async () => {
    await rideOutADropBeforeTheDeadline();
    await neverBackBeforeTheDeadline();
    await reconnectAnswersDecideTheEnd();
    await silenceIsADropAndCtrlCWhileDisconnectedReleasesWithinABound();
    await dropWhileQueued();
    await ctrlCWhileReconnectingBeforeTheGrantCancelsTheRequest();
    await queuedRequestSurvivesRestartsAndEndsWhenTheFarmStaysAway();
  });
});
