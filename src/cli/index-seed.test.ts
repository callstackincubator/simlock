import { describe, expect, it, vi } from "vitest";

import type { SeedMakeInput, SeedMakeOutput, SeedProgressUpdate } from "../admin/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

type Stage = SeedProgressUpdate["progress"];

const iphone = { model: "iPhone 17", osVersion: "26.5", platform: "ios" } as const;

function seedClient(stages: readonly Stage[], result: SeedMakeOutput) {
  const calls: SeedMakeInput[] = [];
  const client = fakeClient({
    makeSeed: async (input, options) => {
      calls.push(input);
      for (const progress of stages) options?.onProgress?.({ kind: result, progress });
      return result;
    },
  });
  return { calls, client };
}

// why: the fake connection reads the credential as the real one does, so the agent-fallback notice stays off stderr.
const signedIn =
  (client: ReturnType<typeof fakeClient>) =>
  async (resolveCredential: () => Promise<string | undefined>) => {
    await resolveCredential();
    return client;
  };

describe("CLI: simlock seed", () => {
  it.each([
    {
      expectedStderr: [
        "seed iPhone 17, iOS 26.5: making the seed…",
        "seed iPhone 17, iOS 26.5: waiting behind another settle…",
        "seed iPhone 17, iOS 26.5: waiting: memory pressure…",
        "seed iPhone 17, iOS 26.5: waiting: free disk below the threshold…",
        "seed iPhone 17, iOS 26.5: waiting: no room for another device…",
        "seed iPhone 17, iOS 26.5: settling…",
      ],
      expectedStdout: "seed iPhone 17, iOS 26.5: settled in 3m01s (1.7 GiB)\n",
      label: "a settled seed",
      result: {
        ...iphone,
        outcome: "settled",
        settledAfterMs: 181_000,
        sizeBytes: 1_800_000_000,
        sourceId: "seed-1",
      },
      stages: [
        { stage: "making" },
        { reason: "settle-running", stage: "waiting" },
        { reason: "memory-pressure", stage: "waiting" },
        { reason: "disk-pressure", stage: "waiting" },
        { reason: "capacity", stage: "waiting" },
        { stage: "settling" },
      ],
    },
    {
      expectedStderr: [],
      expectedStdout: "seed Pixel 8, Android 35 (google_apis): already settled (900 MiB)\n",
      label: "a seed that was already settled, with its image tag",
      result: {
        imageTag: "google_apis",
        model: "Pixel 8",
        osVersion: "35",
        outcome: "already-settled",
        platform: "android",
        sizeBytes: 900 * 1024 ** 2,
        sourceId: "seed-2",
      },
      stages: [],
    },
  ] as const)(
    "prints each stage of $label on stderr and the outcome on stdout, and exits 0",
    async ({ expectedStderr, expectedStdout, result, stages }) => {
      const output = outputCapture();
      const { calls, client } = seedClient(stages, result as SeedMakeOutput);

      const code = await runCli(
        ["seed", result.platform, result.model, "--os", result.osVersion],
        output.environmentWith({
          connectAdmin: signedIn(client),
          readAdminTokenFile: async () => "admin-secret",
        }),
      );

      expect(code).toBe(0);
      expect(calls).toEqual([
        { model: result.model, osVersion: result.osVersion, platform: result.platform },
      ]);
      expect(output.stderr.split("\n").filter((line) => line !== "")).toEqual(expectedStderr);
      expect(output.stdout).toBe(expectedStdout);
    },
  );

  it("passes --image-tag on and with --json prints the answer as one line and no stage lines", async () => {
    const output = outputCapture();
    const result: SeedMakeOutput = {
      ...iphone,
      outcome: "settled",
      settledAfterMs: 5,
      sourceId: "seed-1",
    };
    const { calls, client } = seedClient([{ stage: "making" }], result);

    const code = await runCli(
      ["seed", "android", "Pixel 8", "--image-tag", "google_apis", "--json"],
      output.environmentWith({
        connectAdmin: signedIn(client),
        readAdminTokenFile: async () => "admin-secret",
      }),
    );

    expect(code).toBe(0);
    expect(calls).toEqual([{ imageTag: "google_apis", model: "Pixel 8", platform: "android" }]);
    expect(output.stderr).toBe("");
    expect(output.stdout).toBe(`${JSON.stringify(result)}\n`);
  });

  it.each([
    { argv: ["seed"], label: "no platform word" },
    { argv: ["seed", "windows", "iPhone 17"], label: "a platform word that is not ios or android" },
    { argv: ["seed", "ios"], label: "no model" },
  ])("answers a usage error, exit 2, and asks the daemon nothing for $label", async ({ argv }) => {
    const output = outputCapture();
    const makeSeed = vi.fn();

    const code = await runCli(
      argv,
      output.environmentWith({ connectAdmin: async () => fakeClient({ makeSeed }) }),
    );

    expect(code).toBe(2);
    expect(makeSeed).not.toHaveBeenCalled();
  });
});
