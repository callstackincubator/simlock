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
    tool: "claude-code",
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
});
