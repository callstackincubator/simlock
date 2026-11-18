import { describe, expect, it } from "vitest";
import { runCli, type CliEnvironment } from "./index.js";
import { buildCliEnvironment } from "./environment.js";
import { fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";

const RUN_ID_WORDS = "takes a run id: 1 to 128 letters, digits, `.`, `_` or `-`";

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

// why: the real environment builder reads the variables, so the rows prove the variables, not hand-set fields.
function fromEnv(vars: Record<string, string>): Partial<CliEnvironment> {
  const { runFromEnv, githubRunFromEnv } = buildCliEnvironment(realCliEnvironmentPorts(), vars);
  return {
    ...(runFromEnv === undefined ? {} : { runFromEnv }),
    ...(githubRunFromEnv === undefined ? {} : { githubRunFromEnv }),
  };
}

const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_RUN_ATTEMPT: "2", GITHUB_RUN_ID: "123" };

// why: a part of a decomposed module: the lease tests build the environment with the part that
// owns it, buildCliEnvironment, so the rows prove the variables (ADR 0063 section 2).
describe("simlock lease: the run id a lease carries", () => {
  it("sends the run id --run, else SIMLOCK_RUN, else GitHub Actions' run and attempt name, checked before connecting", async () => {
    const accepted: readonly (readonly [
      string,
      readonly string[],
      Record<string, string>,
      string | undefined,
    ])[] = [
      ["no source", [], {}, undefined],
      ["--run", ["--run", "nightly-7"], {}, "nightly-7"],
      [
        "SIMLOCK_RUN with GitHub variables",
        [],
        { ...GITHUB, SIMLOCK_RUN: "nightly-7" },
        "nightly-7",
      ],
      ["--run over SIMLOCK_RUN", ["--run", "a"], { ...GITHUB, SIMLOCK_RUN: "b" }, "a"],
      ["an empty SIMLOCK_RUN", [], { ...GITHUB, SIMLOCK_RUN: "" }, "123-2"],
      ["no attempt", [], { ...GITHUB, GITHUB_RUN_ATTEMPT: "" }, "123-1"],
      ["not GitHub Actions", [], { GITHUB_RUN_ATTEMPT: "2", GITHUB_RUN_ID: "123" }, undefined],
      ["a GitHub value that fails the rule", [], { ...GITHUB, GITHUB_RUN_ID: "ünï" }, undefined],
    ];
    for (const [name, flags, vars, expected] of accepted) {
      let sent: Record<string, unknown> | undefined;
      const client = fakeClient({
        requestLease: (input) => {
          sent = input as unknown as Record<string, unknown>;
          return Promise.resolve(grant);
        },
      });
      const exitCode = await runCli(
        ["lease", "--platform", "ios", "--detach", ...flags],
        outputCapture().environmentWith({ connectAdmin: async () => client, ...fromEnv(vars) }),
      );
      expect(exitCode, name).toBe(0);
      if (expected === undefined) expect(sent, name).not.toHaveProperty("runId");
      else expect(sent, name).toMatchObject({ runId: expected });
    }

    const refused: readonly (readonly [
      string,
      readonly string[],
      Record<string, string>,
      string,
    ])[] = [
      ["--run with a space", ["--run", "run 1"], {}, `--run ${RUN_ID_WORDS}`],
      ["--run of 129 characters", ["--run", "a".repeat(129)], {}, `--run ${RUN_ID_WORDS}`],
      [
        "SIMLOCK_RUN outside the alphabet",
        [],
        { SIMLOCK_RUN: "ünï" },
        `SIMLOCK_RUN ${RUN_ID_WORDS}`,
      ],
    ];
    for (const [name, flags, vars, message] of refused) {
      let connected = false;
      const output = outputCapture();
      const exitCode = await runCli(
        ["lease", "--platform", "ios", "--detach", ...flags],
        output.environmentWith({
          connectAdmin: async () => {
            connected = true;
            return fakeClient({});
          },
          ...fromEnv(vars),
        }),
      );
      expect(exitCode, name).toBe(2);
      expect(connected, name).toBe(false);
      expect(output.stderr, name).toContain(message);
    }
  });
});
