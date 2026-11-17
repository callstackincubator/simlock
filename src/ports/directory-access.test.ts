import { describe, expect, it } from "vitest";

import { PowerShellDirectoryAccessReader, ScriptedProcessRunner } from "./index.js";

describe("PowerShellDirectoryAccessReader", () => {
  const ARGS = ["-NoProfile", "-NonInteractive", "-Command", /Get-Acl/] as const;

  function runner(result: { readonly stdout: string; readonly code?: number | null }) {
    return new ScriptedProcessRunner([
      {
        match: { args: ARGS, command: "powershell.exe" },
        result: { code: result.code ?? 0, stderr: "", stdout: result.stdout },
      },
    ]);
  }

  it("reads the folder's ACL in one bounded PowerShell call that takes the path from the environment and returns each entry's SID, allow flag and rights", async () => {
    const processRunner = runner({
      stdout: JSON.stringify({
        user: "S-1-5-21-1",
        entries: [
          { sid: "S-1-5-21-1", name: "PC\\me", allow: true, rights: 2_032_127 },
          { sid: "S-1-1-0", name: "Everyone", allow: false, rights: 2_147_483_648 },
        ],
      }),
    });

    const access = await new PowerShellDirectoryAccessReader(processRunner).read("C:\\a'b\\data");

    expect(access).toEqual({
      user: "S-1-5-21-1",
      entries: [
        { sid: "S-1-5-21-1", name: "PC\\me", allow: true, rights: 2_032_127 },
        { sid: "S-1-1-0", name: "Everyone", allow: false, rights: 2_147_483_648 },
      ],
    });
    expect(processRunner.calls).toHaveLength(1);
    const [call] = processRunner.calls;
    expect(call?.options.timeoutMs).toBe(10_000);
    expect(call?.options.env?.SIMLOCK_ACL_PATH).toBe("C:\\a'b\\data");
    const script = call?.args.at(-1) ?? "";
    expect(script).toContain("-LiteralPath $env:SIMLOCK_ACL_PATH");
    expect(script).not.toMatch(/a'{1,2}b/);
  });

  it.each([
    ["a non-zero exit", { stdout: "", code: 1 }, /powershell exited 1/],
    ["output that is not the expected shape", { stdout: '{"user":1}' }, /unexpected ACL output/],
    [
      "an entry with a wrong field type",
      { stdout: '{"user":"S-1","entries":[{"sid":"S-1","name":"x","allow":"yes","rights":1}]}' },
      /unexpected ACL entry/,
    ],
  ])("rejects %s, so the daemon warns nothing", async (_title, result, message) => {
    await expect(
      new PowerShellDirectoryAccessReader(runner(result)).read("C:\\data"),
    ).rejects.toThrow(message);
  });
});
