import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

async function fakeClaude(env: TestEnv): Promise<{ bin: string; record: string }> {
  const bin = join(env.home, "bin");
  const record = join(env.home, "claude-args");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), `#!/bin/sh\nprintf '%s ' "$@" > '${record}'\nexit 0\n`);
  await chmod(join(bin, "claude"), 0o755);
  return { bin, record };
}

describe("simlock setup", () => {
  it("writes the skill where each tool reads it and connects MCP through the tool's command, for real, and starts no daemon", async () => {
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

    const { bin, record } = await fakeClaude(env);
    const mcp = await env.cli(["setup", "--tool", "claude-code", "--mcp"], {
      cwd: project,
      env: { HOME: home, PATH: bin },
    });
    expect(mcp.code).toBe(0);
    expect(mcp.stdout).toContain("claude-code  mcp    connected\n");
    expect(await readFile(record, "utf8")).toBe("mcp add -s user simlock -- simlock mcp ");

    const noCodex = await env.cli(["setup", "--tool", "codex", "--mcp"], {
      cwd: project,
      env: { HOME: home, PATH: bin },
    });
    expect(noCodex.code).toBe(0);
    expect(noCodex.stdout).toContain("codex        mcp    skipped  (codex not found)\n");
    expect(await readFile(join(home, ".agents/skills/simlock/SKILL.md"), "utf8")).toBe(
      renderSkill(),
    );

    const other = join(env.home, "other-home");
    await mkdir(other);
    const projectScope = await env.cli(["setup", "--project", "--tool", "codex", "--no-mcp"], {
      cwd: project,
      env: { HOME: other, PATH: bin },
    });
    expect(projectScope.code).toBe(0);
    expect(await readFile(join(project, ".agents/skills/simlock/SKILL.md"), "utf8")).toBe(
      renderSkill(),
    );
    expect(await readdir(other)).toEqual([]);
  });
});
