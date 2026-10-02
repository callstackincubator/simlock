import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";

/** API 34 has a google_apis and a google_apis_playstore image; API 35 only google_apis. */
const ANDROID_IMAGES = {
  android: {
    availableOsVersions: ["34", "35"],
    images: [
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis" },
      { abi: "arm64-v8a", runtime: "34", tag: "google_apis_playstore" },
      { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
    ],
  },
};

function lease(extra: readonly string[]): string[] {
  return ["lease", "--platform", "android", "--device", "Pixel 8", "--detach", ...extra];
}

describe("lease --image-tag", () => {
  it("grants a device whose spec names the tag, at the newest API level with an image of that tag", async () => {
    const env = await withDaemon({ driverScript: ANDROID_IMAGES });

    const result = await env.cli(lease(["--image-tag", "google_apis_playstore"]));

    expect(result.code).toBe(0);
    expect((result.json as { device: { spec: unknown } }).device.spec).toEqual({
      imageTag: "google_apis_playstore",
      model: "Pixel 8",
      osVersion: "34",
      platform: "android",
    });
  });

  it("fails a tag not installed for the API level with RUNTIME_MISSING (exit 12), --allow-download or not, and never installs", async () => {
    const env = await withDaemon({ driverScript: ANDROID_IMAGES });
    await env.driverLog.clear();
    const tagged = ["--os", "35", "--image-tag", "google_apis_playstore"];

    const plain = await env.cli(lease(tagged));
    const allowed = await env.cli(lease([...tagged, "--allow-download"]));

    for (const result of [plain, allowed]) {
      expect(result.code).toBe(12);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "RUNTIME_MISSING" } });
    }
    const operations = (await env.driverLog.calls()).map((call) => call.operation);
    expect(operations).toContain("resolveSpec");
    expect(operations).not.toContain("installComponent");
    expect(operations).not.toContain("provision");
  });
});
