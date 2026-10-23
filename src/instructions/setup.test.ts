import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "../ports/index.js";
import { renderSkill, setupAgentTools, type SetupAgentToolsOptions } from "./index.js";

const HOME = "/home/operator";
const CWD = "/work/project";

function setup(
  filesystem: MemoryFilesystem,
  options: Partial<Omit<SetupAgentToolsOptions, "filesystem">> = {},
): ReturnType<typeof setupAgentTools> {
  return setupAgentTools({
    filesystem,
    homeDirectory: HOME,
    workingDirectory: CWD,
    scope: "user",
    ...options,
  });
}

async function tree(filesystem: MemoryFilesystem, root: string): Promise<string[]> {
  if (!(await filesystem.exists(root))) return [];
  const paths: string[] = [];
  for (const name of await filesystem.readdir(root)) {
    const path = `${root}/${name}`;
    paths.push(path);
    if ((await filesystem.lstat(path)).kind === "directory")
      paths.push(...(await tree(filesystem, path)));
  }
  return paths.sort();
}

async function withBases(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(HOME);
  await filesystem.mkdirp(CWD);
  return filesystem;
}

describe("setupAgentTools", () => {
  it("writes the skill where each tool reads it for the scope: home for the user scope, the working directory for the project scope", async () => {
    for (const [scope, base, other] of [
      ["user", HOME, CWD],
      ["project", CWD, HOME],
    ] as const) {
      const filesystem = await withBases();
      for (const [tool, skills] of [
        ["claude-code", ".claude/skills"],
        ["codex", ".agents/skills"],
      ] as const) {
        const report = await setup(filesystem, { scope, tool });

        expect(report.scope).toBe(scope);
        expect(report.tools).toEqual([
          { tool, skill: { status: "wrote", path: `${base}/${skills}/simlock` } },
        ]);
        expect(await filesystem.readFile(`${base}/${skills}/simlock/SKILL.md`), tool).toBe(
          renderSkill(),
        );
      }
      expect(await tree(filesystem, other), scope).toEqual([]);
    }
  });

  it("with no tool named, installs the tools set up here and skips the others; a named tool is installed anyway", async () => {
    const claudeOnly = await withBases();
    await claudeOnly.mkdirp(`${HOME}/.claude`);

    expect((await setup(claudeOnly)).tools).toEqual([
      { tool: "claude-code", skill: { status: "wrote", path: `${HOME}/.claude/skills/simlock` } },
      { tool: "codex", skill: { status: "skipped", path: `${HOME}/.agents/skills/simlock` } },
    ]);
    expect(await claudeOnly.exists(`${HOME}/.claude/skills/simlock/SKILL.md`)).toBe(true);
    expect(await claudeOnly.exists(`${HOME}/.agents`)).toBe(false);

    const codexFile = await withBases();
    await codexFile.mkdirp(`${HOME}/.claude`);
    await codexFile.writeFileAtomic(`${HOME}/.codex`, "not a directory");
    const afterFile = await setup(codexFile);
    expect(afterFile.tools.map(({ skill }) => skill.status)).toEqual(["wrote", "skipped"]);
    expect(await codexFile.readFile(`${HOME}/.codex`)).toBe("not a directory");

    const customHome = await withBases();
    await customHome.mkdirp("/custom/codex-home");
    const viaCodexHome = await setup(customHome, { codexHome: "/custom/codex-home" });
    expect(viaCodexHome.tools.map(({ skill }) => skill.status)).toEqual(["skipped", "wrote"]);
    expect(await customHome.exists(`${HOME}/.agents/skills/simlock/SKILL.md`)).toBe(true);

    const bare = await withBases();
    const named = await setup(bare, { tool: "codex" });
    expect(named.tools).toEqual([
      { tool: "codex", skill: { status: "wrote", path: `${HOME}/.agents/skills/simlock` } },
    ]);
    expect(await tree(bare, HOME)).toEqual([
      `${HOME}/.agents`,
      `${HOME}/.agents/skills`,
      `${HOME}/.agents/skills/simlock`,
      `${HOME}/.agents/skills/simlock/SKILL.md`,
    ]);
  });
});
