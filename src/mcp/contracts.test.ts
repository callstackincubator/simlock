import { describe, expect, it } from "vitest";

import {
  leaseSimulatorInputSchema,
  leaseSimulatorOutputSchema,
  MAX_TIMEOUT_SECONDS,
  releaseSimulatorInputSchema,
  releaseSimulatorOutputSchema,
} from "./contracts.js";

describe("MCP contracts", () => {
  it("applies safe lease input defaults", () => {
    expect(leaseSimulatorInputSchema.parse({ device: "iPhone 17 Pro", platform: "ios" })).toEqual({
      allow_download: false,
      device: "iPhone 17 Pro",
      full: false,
      no_wait: false,
      platform: "ios",
    });
  });

  it("accepts an explicit full: true lease input", () => {
    expect(
      leaseSimulatorInputSchema.parse({ device: "iPhone 17 Pro", full: true, platform: "ios" }),
    ).toMatchObject({ full: true });
  });

  it.each([
    [{ device: "", platform: "ios" }],
    [{ device: "Pixel", os: "", platform: "android" }],
    [{ device: "Pixel", platform: "android", timeout_seconds: -1 }],
    [{ device: "Pixel", platform: "android", timeout_seconds: Number.POSITIVE_INFINITY }],
    [{ device: "Pixel", platform: "android", timeout_seconds: MAX_TIMEOUT_SECONDS + 1 }],
  ])("rejects invalid lease inputs", (input) => {
    expect(() => leaseSimulatorInputSchema.parse(input)).toThrow();
  });

  it("validates public success results", () => {
    expect(
      leaseSimulatorOutputSchema.parse({
        device: "iPhone 17 Pro",
        device_id: "ABCD",
        expires_at_ms: 61_000,
        lease_id: "lse_9f2c",
        mode: "held",
        os: "26.5",
        platform: "ios",
        slim: false,
        state: "leased",
        timing: {
          estimated_boot_ms: 20,
          estimated_provision_ms: 10,
          estimated_reclaim_ms: 0,
          estimated_ready_ms: 30,
        },
      }),
    ).toMatchObject({ lease_id: "lse_9f2c", slim: false, state: "leased" });
    expect(releaseSimulatorInputSchema.parse({ lease_id: "lse_9f2c" })).toEqual({
      lease_id: "lse_9f2c",
    });
    expect(releaseSimulatorOutputSchema.parse({ lease_id: "lse_9f2c", released: true })).toEqual({
      lease_id: "lse_9f2c",
      released: true,
    });
  });
});
