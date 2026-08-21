import { describe, expect, it } from "vitest";

import { DeviceOperationClaims } from "./device-operation-claims.js";

describe("DeviceOperationClaims", () => {
  it("grants only one operation claim per device", () => {
    const claims = new DeviceOperationClaims();
    const boot = claims.tryClaim("device-1", "boot");

    expect(boot).toBeDefined();
    expect(claims.tryClaim("device-1", "cleanup")).toBeUndefined();
    expect(claims.operationFor("device-1")).toBe("boot");
    expect(claims.isClaimed("device-1")).toBe(true);
  });

  it("releases claims idempotently and permits the next operation", () => {
    const claims = new DeviceOperationClaims();
    const cleanup = claims.tryClaim("device-1", "cleanup");
    if (cleanup === undefined) throw new Error("expected claim");

    cleanup.release();
    cleanup.release();
    expect(claims.operationFor("device-1")).toBeUndefined();
    expect(claims.isClaimed("device-1")).toBe(false);
    expect(claims.tryClaim("device-1", "nuke")).toBeDefined();
  });

  it("allows independent devices to be claimed concurrently", () => {
    const claims = new DeviceOperationClaims();

    expect(claims.tryClaim("device-1", "eviction")).toBeDefined();
    expect(claims.tryClaim("device-2", "cleanup")).toBeDefined();
  });

  it("makes recovery mutually exclusive with other operations on the same device", () => {
    const claims = new DeviceOperationClaims();
    const boot = claims.tryClaim("device-1", "boot");

    expect(boot).toBeDefined();
    expect(claims.tryClaim("device-1", "recovery")).toBeUndefined();

    boot!.release();
    const recovery = claims.tryClaim("device-1", "recovery");
    expect(recovery).toBeDefined();
    expect(claims.operationFor("device-1")).toBe("recovery");
    expect(claims.tryClaim("device-1", "cleanup")).toBeUndefined();
  });
});
