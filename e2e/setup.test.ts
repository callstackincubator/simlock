import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderSkill } from "../src/instructions/index.js";
import { withDaemon, type TestEnv } from "./helpers/index.js";

async function operatorDirectories(env: TestEnv): Promise<{ home: string; project: string }> {
  const home = join(env.home, "operator-home");
  const project = join(env.home, "project");
  await mkdir(home);
  await mkdir(project);
  return { home, project };
}

describe("simlock setup", () => {
  it("writes the skill where the tool reads it, for real, and starts no daemon", async () => {
    const env = await withDaemon({ mode: "auto" });
    const { home, project } = await operatorDirectories(env);

    const result = await env.cli(["setup", "--tool", "claude-code"], {
      cwd: project,
      env: { HOME: home },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readFile(join(home, ".claude/skills/simlock/SKILL.md"), "utf8")).toBe(
      renderSkill(),
    );
    // why: `mode: "auto"` leaves the daemon unstarted; any daemon-touching command would have
    // auto-started one and left its socket here.
    expect(existsSync(env.socketPath)).toBe(false);
  });
});
