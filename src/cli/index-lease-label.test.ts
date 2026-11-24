import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

const grant = {
  device: {
    physical: false,
    driverDeviceId: "dev_1",
    id: "dev_1",
    mode: "full" as const,
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

describe("simlock lease: the label a lease carries", () => {
  it("sends --label as given, sends none without it, and prints the daemon's refusal of a bad one instead of a local usage error", async () => {
    const sentWith = async (flags: readonly string[]) => {
      let sent: Record<string, unknown> | undefined;
      const exitCode = await runCli(
        ["lease", "--platform", "ios", "--detach", ...flags],
        outputCapture().environmentWith({
          connectAdmin: async () =>
            fakeClient({
              requestLease: (input) => {
                sent = input as unknown as Record<string, unknown>;
                return Promise.resolve(grant);
              },
            }),
        }),
      );
      return { exitCode, sent };
    };

    const labelled = await sentWith(["--label", "feature-x", "--run", "nightly-7"]);
    expect(labelled.exitCode).toBe(0);
    expect(labelled.sent).toMatchObject({ label: "feature-x", runId: "nightly-7" });
    const plain = await sentWith([]);
    expect(plain.exitCode).toBe(0);
    expect(plain.sent).not.toHaveProperty("label");

    const refusal = "label must be 1 to 64 characters";
    let sent: Record<string, unknown> | undefined;
    const output = outputCapture();
    const exitCode = await runCli(
      ["lease", "--platform", "ios", "--detach", "--label", ""],
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (input) => {
              sent = input as unknown as Record<string, unknown>;
              return Promise.reject(
                new SimlockError("BAD_REQUEST", "protocol", refusal, {} as never),
              );
            },
          }),
      }),
    );
    expect(sent).toMatchObject({ label: "" });
    expect(exitCode).toBe(2);
    expect(output.stderr).toContain(refusal);
    expect(output.stderr).toContain("BAD_REQUEST");
    expect(output.stderr).not.toContain("USAGE");
  });
});
