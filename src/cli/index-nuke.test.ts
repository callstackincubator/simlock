import { describe, expect, it } from "vitest";
import type { SimlockAdminClient } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

describe("CLI: simlock nuke --platform", () => {
  async function runNuke(argv: string[], answer = true) {
    const output = outputCapture();
    const inputs: unknown[] = [];
    const prompts: string[] = [];
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        confirm: async (prompt) => {
          prompts.push(prompt);
          return answer;
        },
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            runNuke: ((input: unknown) => {
              inputs.push(input);
              return Promise.resolve({
                deletedDevices: [],
                releasedLeaseIds: [],
                removedBaselines: [],
              });
            }) as SimlockAdminClient["runNuke"],
          });
        },
      }),
    );
    return { code, connected, inputs, prompts, stderr: output.stderr, stdout: output.stdout };
  }

  it("sends the platform it is given, sends none when absent, refuses any other value or a missing one before connecting, asks which platform, and prints the platform in --help", async () => {
    for (const platform of ["ios", "android"]) {
      const run = await runNuke(["nuke", "--delete-devices", "--platform", platform]);
      expect([run.code, run.inputs, run.prompts]).toStrictEqual([
        0,
        [{ deleteDevices: true, platform }],
        [`Nuke Simlock-managed ${platform} devices? [y/N] `],
      ]);
    }

    const absent = await runNuke(["nuke"]);
    expect([absent.code, absent.inputs, absent.prompts]).toStrictEqual([
      0,
      [{ deleteDevices: false }],
      ["Nuke Simlock-managed devices? [y/N] "],
    ]);

    for (const argv of [
      ["nuke", "--yes", "--platform", "windows"],
      ["nuke", "--yes", "--platform", "iOS"],
      ["nuke", "--yes", "--platform"],
    ]) {
      const refused = await runNuke(argv);
      expect([refused.code, refused.connected, argv.join(" ")]).toEqual([2, false, argv.join(" ")]);
      expect(JSON.parse(refused.stderr)).toEqual({
        error: { code: "USAGE", message: expect.any(String) },
      });
    }

    const help = await runNuke(["nuke", "--help"]);
    expect([help.code, help.stdout, help.connected]).toEqual([
      0,
      "Usage: simlock nuke [--delete-devices] [--platform <ios|android>] [--yes]\n",
      false,
    ]);
  });
});
