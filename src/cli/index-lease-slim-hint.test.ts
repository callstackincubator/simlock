import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../ports/index.js";
import { runCli, type CliEnvironment } from "./index.js";
import { fakeClient, outputCapture, settle } from "./test-index.js";
import { SimlockError } from "../contract/index.js";

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
    .flatMap((line) => (line.notice?.startsWith("slim:") === true ? [line.notice] : []));
}

const hintFor = (names: readonly string[]): string =>
  `slim: ${names.join(", ")} off; use --except <name> or --mode full`;

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
    {
      name: "catalog read rejects: no line, grant and exit code as today",
      catalog: iosCatalog(CATEGORIES),
      read: "reject",
      grant,
      flags: [],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "catalog unanswered past 2 s on the fake clock: no line, the command goes on",
      catalog: iosCatalog(CATEGORIES),
      read: "hang",
      grant,
      flags: [],
      lines: [],
      catalogReads: 1,
    },
    {
      name: "--export-env: export lines on stdout, notice on stderr",
      catalog: iosCatalog(CATEGORIES),
      grant: { ...grant, environment: { SIMLOCK_DEVICE: "dev_1" } },
      flags: ["--export-env"],
      lines: [hintFor(CATEGORIES)],
      catalogReads: 1,
      stdout: "export SIMLOCK_DEVICE='dev_1'\n",
    },
    {
      name: "held lease (no --detach): the line is printed while the command holds the lease",
      catalog: iosCatalog(CATEGORIES),
      grant,
      flags: [],
      held: true,
      lines: [hintFor(CATEGORIES)],
      catalogReads: 1,
    },
  ] as {
    name: string;
    held?: boolean;
    catalog: ReturnType<typeof iosCatalog>;
    read?: "reject" | "hang";
    grant: unknown;
    flags: string[];
    lines: string[];
    catalogReads: number;
    stdout?: string;
  }[];

  it("prints one stderr notice naming the slim categories a slim iOS lease has off, and none otherwise", async () => {
    for (const row of rows) {
      const output = outputCapture();
      let catalogReads = 0;
      const signals = new EventEmitter();
      const environment = output.environmentWith({
        signals: signals as unknown as CliEnvironment["signals"],
        connectAdmin: async () =>
          fakeClient({
            getCatalog: () => {
              catalogReads += 1;
              if (row.read === "reject") {
                return Promise.reject(new SimlockError("INTERNAL", "domain", "catalog failed", {}));
              }
              if (row.read === "hang") return new Promise(() => undefined);
              return Promise.resolve(row.catalog);
            },
            requestLease: () => Promise.resolve(row.grant as never),
          }),
      });
      let settled = false;
      const run = runCli(
        ["lease", "--platform", "ios", ...(row.held === true ? [] : ["--detach"]), ...row.flags],
        environment,
      ).then((code) => {
        settled = true;
        return code;
      });
      if (row.read === "hang") {
        await settle();
        expect(output.stdout, `${row.name}: the grant waits for the catalog`).not.toBe("");
      }
      // why: the hint waits at most 2 s of fake time, so the waits advance the clock by no more.
      let advanced = 0;
      await vi.waitFor(
        () => {
          if (advanced < 2_000) {
            (environment.clock as FakeClock).advance(500);
            advanced += 500;
          }
          if (row.held === true) {
            expect(output.stderr, `${row.name}: the hint is out`).toContain("slim:");
          } else {
            expect(settled, `${row.name}: the command has not ended`).toBe(true);
          }
        },
        { timeout: 10_000 },
      );
      if (row.held === true) {
        expect(settled, `${row.name}: the command still holds the lease`).toBe(false);
        signals.emit("SIGINT");
      }
      const exitCode = await run;
      expect(exitCode, row.name).toBe(0);
      expect(hintLines(output.stderr), row.name).toEqual(row.lines);
      expect(catalogReads, row.name).toBe(row.catalogReads);
      if (row.stdout !== undefined) expect(output.stdout, row.name).toBe(row.stdout);
    }
  });
});
