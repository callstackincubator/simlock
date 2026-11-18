import { describe, expect, it } from "vitest";
import { FakeDriver } from "../core/testing.js";
import { FakeClock } from "../ports/index.js";
import type { StateDatabase } from "../state/index.js";
import { buildDispatcher, session } from "./test-dispatcher.js";

type Built = Awaited<ReturnType<typeof buildDispatcher>>;
type BuildOptions = NonNullable<Parameters<typeof buildDispatcher>[0]>;

type Modes = readonly ("slim" | "full")[] | undefined;

interface Case {
  readonly name: string;
  readonly modes: Modes;
  readonly request: Record<string, unknown>;
  /** why: the options only this case needs, built with the case's clock so a second driver shares it. */
  readonly setup?: (clock: FakeClock) => BuildOptions;
  readonly prepare?: (built: Built) => Promise<void>;
  readonly granted?: "slim" | "full" | "physical" | "android";
  readonly refused?: {
    readonly mode: "slim" | "full";
    readonly message: string;
    readonly installs: boolean;
  };
}

const slimOnly = '["slim"]';
const askedFull =
  `This worker does not serve full iOS simulators (ios.modes is ${slimOnly}); ` +
  'ask for a slim one (--mode slim, or mode: "slim")';
const cannotSlim = (os: string) =>
  `iOS ${os} cannot be slimmed, and this worker does not serve full iOS simulators ` +
  `(ios.modes is ${slimOnly}); ask for iOS 18.5 or newer`;

const phone = { model: "iPhone 17 Pro", platform: "ios" } as const;

// why: "checkout" is the full baseline a worker made before it switched to slim-only; only its row and source exist, since a refused request never copies it. "quick" is made the way an agent makes one, from a slim lease.
const withBaselines = {
  prepare: async ({ dispatcher, driver }: Built) => {
    const grant = await dispatcher.dispatch(
      "lease.request",
      phone,
      session({ principal: "maker" }),
    );
    await dispatcher.dispatch(
      "baseline.save",
      { leaseId: grant.lease.id, name: "quick" },
      session({ role: "admin" }),
    );
    driver.setSources([
      ...(await driver.listSources()),
      { id: "src-checkout", kind: "baseline", model: "iPhone 17 Pro", osVersion: "26.5" },
    ]);
  },
  setup: () => ({
    seedState: ({ database }: StateDatabase) => {
      database
        .prepare(
          "INSERT INTO baselines (name, version, platform, model, os_version, mode, saved_at, source_id) VALUES ('checkout', 1, 'ios', 'iPhone 17 Pro', '26.5', 'full', '2026-11-02T13:40:00.000Z', 'src-checkout')",
        )
        .run();
    },
  }),
};

const baselineRefusal = (mode: string) =>
  `Baseline "checkout" is ${mode}, and this worker does not serve ${mode} iOS simulators ` +
  `(ios.modes is ${slimOnly})`;

const cases: readonly Case[] = [
  { name: "no mode", modes: ["slim"], request: phone, granted: "slim" },
  {
    name: "--mode full",
    modes: ["slim"],
    request: { ...phone, mode: "full" },
    refused: { installs: false, message: askedFull, mode: "full" },
  },
  {
    name: "--mode slim below 18.5",
    modes: ["slim"],
    request: { ...phone, mode: "slim", osVersion: "17.5" },
    refused: { installs: false, message: cannotSlim("17.5"), mode: "full" },
  },
  {
    name: "no mode below 18.5",
    modes: ["slim"],
    request: { ...phone, osVersion: "17.5" },
    refused: { installs: false, message: cannotSlim("17.5"), mode: "full" },
  },
  {
    name: "--mode full --allow-download of a missing version",
    modes: ["slim"],
    request: { ...phone, allowDownload: true, mode: "full", osVersion: "26.2" },
    refused: { installs: false, message: askedFull, mode: "full" },
  },
  {
    name: "--mode slim --allow-download of a missing version below 18.5",
    modes: ["slim"],
    request: { ...phone, allowDownload: true, mode: "slim", osVersion: "17.4" },
    refused: { installs: true, message: cannotSlim("17.4"), mode: "full" },
  },
  {
    name: "--mode slim on a full-only worker",
    modes: ["full"],
    request: { ...phone, mode: "slim" },
    refused: {
      installs: false,
      message:
        'This worker does not serve slim iOS simulators (ios.modes is ["full"]); ' +
        'ask for a full one (--mode full, or mode: "full")',
      mode: "slim",
    },
  },
  {
    name: "--mode full with ios.modes unset",
    modes: undefined,
    request: { ...phone, mode: "full" },
    granted: "full",
  },
  {
    name: "a full baseline",
    modes: ["slim"],
    request: { baseline: "checkout", platform: "ios" },
    ...withBaselines,
    refused: { installs: false, message: baselineRefusal("full"), mode: "full" },
  },
  {
    name: "a slim baseline",
    modes: ["slim"],
    request: { baseline: "quick", platform: "ios" },
    ...withBaselines,
    granted: "slim",
  },
  {
    name: "--mode full with --no-wait",
    modes: ["slim"],
    request: { ...phone, mode: "full", noWait: true },
    refused: { installs: false, message: askedFull, mode: "full" },
  },
  {
    name: "--physical",
    modes: ["slim"],
    request: { model: "iPad Pro", physical: true, platform: "ios" },
    prepare: async ({ driver, engine }) => {
      await engine.convergeRunningCapacity();
      driver.setPhysicalPresence("00008110-001A2B3C4D5E", true);
    },
    setup: () => ({
      physicalDevices: [
        {
          createdAt: 1,
          driverDeviceId: "00008110-001A2B3C4D5E",
          enrolledApps: [],
          id: "dev_phys",
          spec: { class: "tablet", model: "iPad Pro", osVersion: "18.4" },
          state: "ready",
        },
      ],
    }),
    granted: "physical",
  },
  {
    name: "an Android lease",
    modes: ["slim"],
    request: { model: "Pixel 9", platform: "android" },
    setup: (clock) => ({
      extraDrivers: [
        new FakeDriver({
          availableOsVersions: ["36"],
          clock,
          knownModels: ["Pixel 9"],
          platform: "android",
        }),
      ],
    }),
    granted: "android",
  },
];

describe("Dispatcher: the iOS modes a worker serves", () => {
  it("refuses an iOS lease whose resolved mode ios.modes does not list with MODE_UNAVAILABLE and its details, before any download unless the version can only be known after it, and grants a served one", async () => {
    for (const testCase of cases) {
      const clock = new FakeClock(1_000);
      const built = await buildDispatcher({
        clock,
        driverOptions: { availableOsVersions: ["26.5", "17.5"], slimmableOsVersions: ["26.5"] },
        ...(testCase.modes === undefined ? {} : { iosModes: testCase.modes }),
        ...testCase.setup?.(clock),
      });
      const { dispatcher, driver, eventBus } = built;
      await testCase.prepare?.(built);
      const requestedBefore = eventBus.replay().filter((e) => e.event === "lease.requested").length;

      const outcome = await dispatcher
        .dispatch("lease.request", testCase.request as never, session())
        .then(
          (grant) =>
            grant.device.physical === true
              ? "physical"
              : grant.device.spec.platform === "android"
                ? "android"
                : grant.device.mode,
          (error: unknown) => error,
        );

      if (testCase.granted !== undefined) {
        expect(outcome, testCase.name).toBe(testCase.granted);
        continue;
      }
      const refused = testCase.refused!;
      expect(outcome, testCase.name).toMatchObject({
        code: "MODE_UNAVAILABLE",
        details: { mode: refused.mode, platform: "ios", served: testCase.modes },
        message: refused.message,
      });
      const installs = driver.calls.filter((call) => call.operation === "installComponent");
      expect(installs.length > 0, `${testCase.name}: installs`).toBe(refused.installs);
      const events = eventBus.replay();
      expect(
        events.filter((event) => event.event === "lease.requested").length - requestedBefore,
        `${testCase.name}: stored`,
      ).toBe(1);
      expect(
        events.filter((event) => event.event === "lease.rejected").map((event) => event.payload),
        `${testCase.name}: rejected`,
      ).toMatchObject([{ reason: "unresolvable-spec" }]);
    }
  });
});
