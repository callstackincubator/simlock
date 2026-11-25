import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { runCli } from "./index.js";
import { detachedGrant, fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

const FARM_ENV = {
  SIMLOCK_AGENT_ID: "agent-a",
  SIMLOCK_TOKEN: "slk_t",
  SIMLOCK_URL: "https://farm.example.com",
};

describe("simlock lease --requires", () => {
  it("sends the names as a list, adds the idempotency key with --url, and prints the daemon's refusal of an empty value", async () => {
    const sentLocally = async (flags: readonly string[]) => {
      let sent: Record<string, unknown> | undefined;
      const exitCode = await runCli(
        ["lease", "--platform", "android", "--detach", ...flags],
        outputCapture().environmentWith({
          connectAdmin: async () =>
            fakeClient({
              requestLease: (input) => {
                sent = input as unknown as Record<string, unknown>;
                return Promise.resolve(detachedGrant);
              },
            }),
        }),
      );
      return { exitCode, sent };
    };

    const one = await sentLocally(["--requires", "bank-network"]);
    expect(one.exitCode).toBe(0);
    expect(one.sent).toMatchObject({ requires: ["bank-network"] });
    const two = await sentLocally(["--requires", "bank-network,eu-west"]);
    expect(two.sent).toMatchObject({ requires: ["bank-network", "eu-west"] });
    expect((await sentLocally([])).sent).not.toHaveProperty("requires");

    const farm = new FakeFarm({ "lease.request": () => detachedGrant });
    const farmOutput = outputCapture(realCliEnvironmentPorts(), FARM_ENV);
    const farmExit = await runCli(
      ["lease", "--platform", "android", "--detach", "--requires", "bank-network,eu-west"],
      farmOutput.environmentWith({ webSocket: farm }),
    );
    expect(farmExit).toBe(0);
    expect(farm.requests.find(({ type }) => type === "lease.request")?.payload).toMatchObject({
      idempotencyKey: expect.any(String),
      requires: ["bank-network", "eu-west"],
    });

    const refusal = "requires must name 1 to 8 capabilities";
    let emptySent: Record<string, unknown> | undefined;
    const refused = outputCapture();
    const refusedExit = await runCli(
      ["lease", "--platform", "android", "--detach", "--requires", ""],
      refused.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            requestLease: (input) => {
              emptySent = input as unknown as Record<string, unknown>;
              return Promise.reject(
                new SimlockError("BAD_REQUEST", "protocol", refusal, {} as never),
              );
            },
          }),
      }),
    );
    expect(emptySent).toMatchObject({ requires: [""] });
    expect(refusedExit).toBe(2);
    expect(refused.stderr).toContain("BAD_REQUEST");
    expect(refused.stderr).toContain(refusal);

    const help = outputCapture();
    await runCli(["lease", "--help"], help.environmentWith({}));
    expect(help.stdout).toContain("[--requires <capability,...>]");
  });
});
