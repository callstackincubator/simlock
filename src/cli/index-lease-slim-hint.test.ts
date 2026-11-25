import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

const CATEGORIES = [
  "mdm",
  "store",
  "other",
  "siri",
  "widgets",
  "push",
  "spotlight",
  "icloud",
  "passkit",
  "health",
  "maps",
  "news",
  "photos",
  "music",
  "wallet",
  "weather",
];

const grant = {
  device: {
    physical: false,
    driverDeviceId: "dev_1",
    id: "dev_1",
    mode: "slim" as const,
    spec: { physical: false, model: "iPhone 17", osVersion: "26.5", platform: "ios" as const },
  },
  environment: {},
  lease: {
    deviceId: "dev_1",
    grantedAt: 0,
    id: "lse_1",
    lastRenewedAt: 0,
    idChosenByRequester: false,
    ownerId: "test-requester",
    requesterId: "test-requester",
    ttlDeadline: 60_000,
    ttlMs: 60_000,
  },
  timing: {
    estimatedBootMs: 0,
    estimatedProvisionMs: 0,
    estimatedReadyMs: 0,
    estimatedReclaimMs: 0,
  },
};

function iosCatalog(slimCategories: readonly string[]) {
  return {
    platforms: [
      {
        platform: "ios" as const,
        models: [],
        runtimes: [],
        modelRuntimes: {},
        modelAliases: {},
        modelClasses: {},
        classDefaults: {},
        slimCategories: [...slimCategories],
      },
    ],
  };
}

function hintLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { notice?: string })
    .flatMap((line) => (line.notice?.startsWith("Slim simulator:") === true ? [line.notice] : []));
}

const HINT_TAIL =
  "are turned off. Lease again with except naming a category to keep it running, or with mode full to keep them all.";
const hintFor = (names: readonly string[]): string =>
  `Slim simulator: ${names.join(", ")} ${HINT_TAIL}`;

type Grant = typeof grant;
const withDevice = (device: Partial<Grant["device"]> & { except?: string[] }): Grant => ({
  ...grant,
  device: { ...grant.device, ...device },
});

describe("simlock lease: the slim hint line", () => {
  const rows = [
    {
      name: "catalog all 16, no except: all 16 in catalog order",
      catalog: iosCatalog(CATEGORIES),
      grant,
      flags: [],
      lines: [hintFor(CATEGORIES)],
      catalogReads: 1,
    },
    {
      name: "--except siri: 15, no siri",
      catalog: iosCatalog(CATEGORIES),
      grant: withDevice({ except: ["siri"] }),
      flags: ["--except", "siri"],
      lines: [hintFor(CATEGORIES.filter((name) => name !== "siri"))],
      catalogReads: 1,
    },
    {
      name: "except covers the list: no line",
      catalog: iosCatalog(["store", "other"]),
      grant: withDevice({ except: ["store", "other"] }),
      flags: ["--except", "store,other"],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "slimCategories []: no line",
      catalog: iosCatalog([]),
      grant,
      flags: [],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "slimCategories absent: no line",
      catalog: { platforms: [{ ...iosCatalog([]).platforms[0]!, slimCategories: undefined }] },
      grant,
      flags: [],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "no iOS entry: no line",
      catalog: { platforms: [] },
      grant,
      flags: [],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "full: no line and no catalog read",
      catalog: iosCatalog(CATEGORIES),
      grant: withDevice({ mode: "full" as never }),
      flags: [],
      lines: [],
      catalogReads: 0,
    },
    {
      name: "Android: no line and no catalog read",
      catalog: iosCatalog(CATEGORIES),
      grant: {
        ...grant,
        device: {
          ...grant.device,
          spec: { ...grant.device.spec, platform: "android" as never },
        },
      },
      flags: [],
      lines: [],
      catalogReads: 0,
    },
    {
      name: "physical: no line and no catalog read",
      catalog: iosCatalog(CATEGORIES),
      grant: withDevice({ physical: true }),
      flags: [],
      lines: [],
      catalogReads: 0,
    },
  ];

  it("prints one stderr notice naming the slim categories a slim iOS lease has off, and none otherwise", async () => {
    for (const row of rows) {
      const output = outputCapture();
      let catalogReads = 0;
      const exitCode = await runCli(
        ["lease", "--platform", "ios", "--detach", ...row.flags],
        output.environmentWith({
          connectAdmin: async () =>
            fakeClient({
              getCatalog: () => {
                catalogReads += 1;
                return Promise.resolve(row.catalog);
              },
              requestLease: () => Promise.resolve(row.grant as never),
            }),
        }),
      );
      expect(exitCode, row.name).toBe(0);
      expect(hintLines(output.stderr), row.name).toEqual(row.lines);
      expect(catalogReads, row.name).toBe(row.catalogReads);
    }
  });
});
