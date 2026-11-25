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

describe("simlock lease: the slim hint line", () => {
  it("prints one stderr notice naming the slim categories a slim iOS lease has off, in catalog order", async () => {
    const output = outputCapture();
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--detach"],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            getCatalog: () => Promise.resolve(iosCatalog(CATEGORIES)),
            requestLease: () => Promise.resolve(grant),
          }),
      }),
    );
    expect(exitCode).toBe(0);
    expect(hintLines(output.stderr)).toEqual([
      `Slim simulator: ${CATEGORIES.join(", ")} are turned off. Lease again with except naming a category to keep it running, or with mode full to keep them all.`,
    ]);
  });
});
