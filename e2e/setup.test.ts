import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withDaemon, type TestEnv } from "./helpers/index.js";

/** An empty home and an empty project directory inside the test's own temp directory. */
async function operatorDirectories(env: TestEnv): Promise<{ home: string; project: string }> {
  const home = join(env.home, "operator-home");
  const project = join(env.home, "project");
  await mkdir(home);
  await mkdir(project);
  return { home, project };
}

describe("simlock setup", () => {
  it("--tool claude-code writes .claude/skills/simlock/SKILL.md under HOME, exits 0, and starts no daemon", async () => {
    const env = await withDaemon({ mode: "auto" });
    const { home, project } = await operatorDirectories(env);

    const result = await env.cli(["setup", "--tool", "claude-code"], {
      cwd: project,
      env: { HOME: home },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const skillDirectory = join(home, ".claude/skills/simlock");
    expect(result.stdout).toBe(`claude-code  wrote  ${skillDirectory}\n`);
    expect(await readdir(skillDirectory)).toEqual(["SKILL.md"]);
    expect(await readdir(project)).toEqual([]);
    // `mode: "auto"` leaves the daemon unstarted; any daemon-touching command would have
    // auto-started one and left its socket here.
    expect(existsSync(env.socketPath)).toBe(false);
  });

  it("--project --tool codex writes .codex/skills/simlock/SKILL.md under the working directory and nothing under HOME", async () => {
    const env = await withDaemon({ mode: "auto" });
    const { home, project } = await operatorDirectories(env);

    const result = await env.cli(["setup", "--project", "--tool", "codex", "--json"], {
      cwd: project,
      env: { HOME: home },
    });

    expect(result.code).toBe(0);
    // The CLI reports the directory the way `process.cwd()` spells it, which on macOS is the
    // resolved `/private/var/...` form of a temp directory.
    const report = result.json as { scope: string; tools: { tool: string; path: string }[] };
    expect(report.scope).toBe("project");
    expect(report.tools).toHaveLength(1);
    expect(report.tools[0]).toMatchObject({ tool: "codex", status: "wrote" });
    expect(report.tools[0]?.path.endsWith(join("project", ".codex/skills/simlock"))).toBe(true);
    expect(await readdir(join(project, ".codex/skills/simlock"))).toEqual(["SKILL.md"]);
    expect(await readdir(home)).toEqual([]);
  });

  it("the installed SKILL.md ends with exactly the text simlock instructions prints", async () => {
    const env = await withDaemon({ mode: "auto" });
    const { home, project } = await operatorDirectories(env);

    const instructions = await env.cli(["instructions"]);
    const setup = await env.cli(["setup", "--tool", "claude-code"], {
      cwd: project,
      env: { HOME: home },
    });

    expect(instructions.code).toBe(0);
    expect(setup.code).toBe(0);
    const skill = await readFile(join(home, ".claude/skills/simlock/SKILL.md"), "utf8");
    expect(instructions.stdout.length).toBeGreaterThan(0);
    expect(skill.endsWith(instructions.stdout)).toBe(true);
    expect(skill.startsWith("---\nname: simlock\n")).toBe(true);
  });
});
