import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryFilesystem, NodeFilesystem } from "../ports/filesystem.js";
import { renderSkill } from "./index.js";
import { SetupRefusedError, setupAgentTools, type SetupAgentToolsOptions } from "./setup.js";

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

/** Every path under `root`, files and directories, so a test can say "nothing else changed". */
async function tree(filesystem: MemoryFilesystem, root: string): Promise<string[]> {
  if (!(await filesystem.exists(root))) return [];
  const paths: string[] = [];
  for (const name of await filesystem.readdir(root)) {
    const path = root === "/" ? `/${name}` : `${root}/${name}`;
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
  it("installs a named tool even when its presence directory is missing, creating the skills directory", async () => {
    const filesystem = await withBases();

    const report = await setup(filesystem, { tool: "codex" });

    expect(report).toEqual({
      scope: "user",
      tools: [{ tool: "codex", status: "wrote", path: `${HOME}/.codex/skills/simlock` }],
    });
    expect(await filesystem.readFile(`${HOME}/.codex/skills/simlock/SKILL.md`)).toBe(renderSkill());
    expect(await tree(filesystem, HOME)).toEqual([
      `${HOME}/.codex`,
      `${HOME}/.codex/skills`,
      `${HOME}/.codex/skills/simlock`,
      `${HOME}/.codex/skills/simlock/SKILL.md`,
    ]);
  });

  it("with no tool named, installs only tools whose presence directory exists and reports the others as skipped", async () => {
    const filesystem = await withBases();
    await filesystem.mkdirp(`${HOME}/.claude`);

    const report = await setup(filesystem);

    expect(report.tools).toEqual([
      { tool: "claude-code", status: "wrote", path: `${HOME}/.claude/skills/simlock` },
      { tool: "codex", status: "skipped", path: `${HOME}/.codex/skills/simlock` },
    ]);
    expect(await filesystem.exists(`${HOME}/.claude/skills/simlock/SKILL.md`)).toBe(true);
    expect(await filesystem.exists(`${HOME}/.codex`)).toBe(false);
  });

  it("with no tool named, a file where a tool's presence directory belongs counts as not set up", async () => {
    const filesystem = await withBases();
    await filesystem.mkdirp(`${HOME}/.claude`);
    await filesystem.writeFileAtomic(`${HOME}/.codex`, "not a directory");

    const report = await setup(filesystem);

    expect(report.tools.map(({ status }) => status)).toEqual(["wrote", "skipped"]);
    expect(await filesystem.readFile(`${HOME}/.codex`)).toBe("not a directory");
  });

  it("the project scope writes under the working directory and nothing under the home directory, and the user scope the reverse", async () => {
    const project = await withBases();
    const projectReport = await setup(project, { scope: "project", tool: "claude-code" });
    expect(projectReport.scope).toBe("project");
    expect(await tree(project, CWD)).toContain(`${CWD}/.claude/skills/simlock/SKILL.md`);
    expect(await tree(project, HOME)).toEqual([]);

    const user = await withBases();
    const userReport = await setup(user, { scope: "user", tool: "claude-code" });
    expect(userReport.scope).toBe("user");
    expect(await tree(user, HOME)).toContain(`${HOME}/.claude/skills/simlock/SKILL.md`);
    expect(await tree(user, CWD)).toEqual([]);
  });

  it("a second run reports replaced and leaves the same files", async () => {
    const filesystem = await withBases();
    await filesystem.mkdirp(`${HOME}/.claude`);
    await filesystem.mkdirp(`${HOME}/.codex`);
    await setup(filesystem);
    const first = await tree(filesystem, HOME);

    const report = await setup(filesystem);

    expect(report.tools.map(({ status }) => status)).toEqual(["replaced", "replaced"]);
    expect(await tree(filesystem, HOME)).toEqual(first);
    for (const tool of [".claude", ".codex"])
      expect(await filesystem.readFile(`${HOME}/${tool}/skills/simlock/SKILL.md`)).toBe(
        renderSkill(),
      );
  });

  it("removes a stale file inside the Simlock directory from an earlier run, and overwrites an old SKILL.md", async () => {
    const filesystem = await withBases();
    await filesystem.mkdirp(`${HOME}/.claude/skills/simlock/old`);
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/simlock/old/notes.md`, "stale");
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/simlock/SKILL.md`, "old rules");
    await filesystem.writeFileAtomic(`${HOME}/.claude/skills/other.md`, "not ours");

    const report = await setup(filesystem, { tool: "claude-code" });

    expect(report.tools).toEqual([
      { tool: "claude-code", status: "replaced", path: `${HOME}/.claude/skills/simlock` },
    ]);
    expect(await tree(filesystem, `${HOME}/.claude/skills`)).toEqual([
      `${HOME}/.claude/skills/other.md`,
      `${HOME}/.claude/skills/simlock`,
      `${HOME}/.claude/skills/simlock/SKILL.md`,
    ]);
    expect(await filesystem.readFile(`${HOME}/.claude/skills/simlock/SKILL.md`)).toBe(
      renderSkill(),
    );
    expect(await filesystem.readFile(`${HOME}/.claude/skills/other.md`)).toBe("not ours");
  });

  // On the real filesystem: a rename onto a directory fails there, and the in-memory double
  // would quietly let it through.
  it("replaces a directory named SKILL.md inside the Simlock directory with the skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "simlock-setup-"));
    try {
      const simlock = join(home, ".codex/skills/simlock");
      await mkdir(join(simlock, "SKILL.md/nested"), { recursive: true });

      const report = await setupAgentTools({
        filesystem: new NodeFilesystem(),
        homeDirectory: home,
        workingDirectory: CWD,
        scope: "user",
        tool: "codex",
      });

      expect(report.tools.map(({ status }) => status)).toEqual(["replaced"]);
      expect(await readdir(simlock)).toEqual(["SKILL.md"]);
      expect(await readFile(join(simlock, "SKILL.md"), "utf8")).toBe(renderSkill());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "file",
      async (filesystem: MemoryFilesystem, path: string) =>
        filesystem.writeFileAtomic(path, "someone else's"),
    ],
    [
      "symlink",
      async (filesystem: MemoryFilesystem, path: string) => {
        await filesystem.mkdirp("/elsewhere");
        filesystem.defineSymlink(path, "/elsewhere");
      },
    ],
  ])(
    "a %s at the Simlock directory path refuses the run, and nothing is written for any tool",
    async (_kind, place) => {
      const filesystem = await withBases();
      await filesystem.mkdirp(`${HOME}/.claude`);
      await filesystem.mkdirp(`${HOME}/.codex/skills`);
      // codex comes second in the table, so a refusal that only stopped at the bad tool would
      // already have written claude-code's skill.
      await place(filesystem, `${HOME}/.codex/skills/simlock`);
      const before = await tree(filesystem, "/");

      const run = setup(filesystem);

      await expect(run).rejects.toBeInstanceOf(SetupRefusedError);
      await expect(run).rejects.toThrow(`${HOME}/.codex/skills/simlock`);
      expect(await tree(filesystem, "/")).toEqual(before);
    },
  );
});
