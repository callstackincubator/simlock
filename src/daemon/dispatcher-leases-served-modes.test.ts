import { describe, expect, it } from "vitest";
import { buildDispatcher, session } from "./test-dispatcher.js";

type Modes = readonly ("slim" | "full")[] | undefined;

interface Case {
  readonly name: string;
  readonly modes: Modes;
  readonly request: Record<string, unknown>;
  readonly granted?: "slim" | "full";
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

const cases: readonly Case[] = [
  { name: "no mode", modes: ["slim"], request: {}, granted: "slim" },
  {
    name: "--mode full",
    modes: ["slim"],
    request: { mode: "full" },
    refused: { installs: false, message: askedFull, mode: "full" },
  },
  {
    name: "--mode slim below 18.5",
    modes: ["slim"],
    request: { mode: "slim", osVersion: "17.5" },
    refused: { installs: false, message: cannotSlim("17.5"), mode: "full" },
  },
  {
    name: "no mode below 18.5",
    modes: ["slim"],
    request: { osVersion: "17.5" },
    refused: { installs: false, message: cannotSlim("17.5"), mode: "full" },
  },
  {
    name: "--mode full --allow-download of a missing version",
    modes: ["slim"],
    request: { allowDownload: true, mode: "full", osVersion: "26.2" },
    refused: { installs: false, message: askedFull, mode: "full" },
  },
  {
    name: "--mode slim --allow-download of a missing version below 18.5",
    modes: ["slim"],
    request: { allowDownload: true, mode: "slim", osVersion: "17.4" },
    refused: { installs: true, message: cannotSlim("17.4"), mode: "full" },
  },
  {
    name: "--mode slim on a full-only worker",
    modes: ["full"],
    request: { mode: "slim" },
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
    request: { mode: "full" },
    granted: "full",
  },
];

describe("Dispatcher: the iOS modes a worker serves", () => {
  it("refuses an iOS lease whose resolved mode ios.modes does not list with MODE_UNAVAILABLE and its details, before any download unless the version can only be known after it, and grants a served one", async () => {
    for (const testCase of cases) {
      const { dispatcher, driver, eventBus } = await buildDispatcher({
        driverOptions: { availableOsVersions: ["26.5", "17.5"], slimmableOsVersions: ["26.5"] },
        ...(testCase.modes === undefined ? {} : { iosModes: testCase.modes }),
      });
      const request = { model: "iPhone 17 Pro", platform: "ios", ...testCase.request } as const;

      const outcome = await dispatcher.dispatch("lease.request", request, session()).then(
        (grant) => grant.device.mode,
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
        events.filter((event) => event.event === "lease.requested"),
        `${testCase.name}: stored`,
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event === "lease.rejected").map((event) => event.payload),
        `${testCase.name}: rejected`,
      ).toMatchObject([{ reason: "unresolvable-spec" }]);
    }
  });
});
