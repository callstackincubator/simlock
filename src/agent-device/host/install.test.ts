import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "../../ports/index.js";
import { findAgentDevice, pathVariableOf } from "./install.js";

const npm = "/Users/me/AppData/Roaming/npm";
const packageRoot = `${npm}/node_modules/agent-device`;

/** why: npm on Windows lays out a global install as a `.cmd` shim beside `node_modules`, every file 0o666. */
async function windowsNpmInstall(
  options: { readonly bin?: unknown; readonly shim?: boolean } = {},
): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp(`${packageRoot}/bin`);
  await filesystem.mkdirp(`${packageRoot}/dist/src/internal`);
  if (options.shim !== false)
    await filesystem.writeFileAtomic(`${npm}/agent-device.cmd`, "@node ...");
  await filesystem.writeFileAtomic(
    `${packageRoot}/package.json`,
    JSON.stringify({
      bin: options.bin ?? { "agent-device": "bin/agent-device.mjs" },
      name: "agent-device",
    }),
  );
  await filesystem.writeFileAtomic(`${packageRoot}/bin/agent-device.mjs`, "#!/usr/bin/env node\n");
  await filesystem.writeFileAtomic(`${packageRoot}/dist/src/internal/daemon.js`, "");
  for (const path of [`${npm}/agent-device.cmd`, `${packageRoot}/bin/agent-device.mjs`]) {
    if (await filesystem.exists(path)) filesystem.defineAttributes(path, { mode: 0o666 });
  }
  return filesystem;
}

// why: pure lookup rules, per platform, with many cases the supervisor's own tests reach only one at a time.
describe("findAgentDevice", () => {
  it.each([
    ["an object", { "agent-device": "bin/agent-device.mjs" }],
    ["a string", "./bin/agent-device.mjs"],
  ])(
    "finds an npm .cmd shim on a Windows PATH and stands in its package's bin, named as %s",
    async (_form, bin) => {
      const filesystem = await windowsNpmInstall({ bin });

      await expect(
        findAgentDevice(filesystem, "agent-device", `/Windows/System32;${npm};/other`, "win32"),
      ).resolves.toEqual({
        entry: `${packageRoot}/dist/src/internal/daemon.js`,
        ok: true,
        realPath: `${packageRoot}/bin/agent-device.mjs`,
      });
    },
  );

  it("does not take a package with no .cmd shim beside it as the command on Windows", async () => {
    const filesystem = await windowsNpmInstall({ shim: false });

    await expect(findAgentDevice(filesystem, "agent-device", npm, "win32")).resolves.toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("accepts a configured path to the bin file on Windows, where no file has an execute bit", async () => {
    const filesystem = await windowsNpmInstall();
    const bin = `${packageRoot}/bin/agent-device.mjs`;

    await expect(findAgentDevice(filesystem, bin, undefined, "win32")).resolves.toMatchObject({
      ok: true,
      realPath: bin,
    });
    await expect(findAgentDevice(filesystem, bin, undefined, "linux")).resolves.toMatchObject({
      ok: false,
      reason: "not-found",
    });
  });

  it("still splits PATH on ':' and ignores .cmd shims off Windows", async () => {
    const filesystem = await windowsNpmInstall();

    await expect(
      findAgentDevice(filesystem, "agent-device", `/usr/bin:${npm}`, "linux"),
    ).resolves.toMatchObject({ ok: false, reason: "not-found" });
  });
});

describe("pathVariableOf", () => {
  it.each([
    ["PATH", { PATH: "/usr/bin" }, "/usr/bin"],
    ["Windows' Path", { Path: "C:\\npm;C:\\bin" }, "C:\\npm;C:\\bin"],
    ["none", { HOME: "/home/me" }, undefined],
  ])("reads %s", (_name, environment, expected) => {
    expect(pathVariableOf(environment)).toBe(expected);
  });
});
