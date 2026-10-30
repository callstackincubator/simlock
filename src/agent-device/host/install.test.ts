import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MemoryFilesystem, NodeFilesystem } from "../../ports/index.js";
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

  it("finds a local install's shim in node_modules/.bin, its package beside .bin", async () => {
    const project = "/work/app/node_modules";
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp(`${project}/.bin`);
    await filesystem.mkdirp(`${project}/agent-device/bin`);
    await filesystem.mkdirp(`${project}/agent-device/dist/src`);
    await filesystem.writeFileAtomic(`${project}/.bin/agent-device.cmd`, "@node ...");
    await filesystem.writeFileAtomic(
      `${project}/agent-device/package.json`,
      JSON.stringify({ bin: { "agent-device": "bin/agent-device.mjs" }, name: "agent-device" }),
    );
    await filesystem.writeFileAtomic(`${project}/agent-device/bin/agent-device.mjs`, "");
    await filesystem.writeFileAtomic(`${project}/agent-device/dist/src/daemon.js`, "");

    await expect(
      findAgentDevice(filesystem, "agent-device", `/Windows;${project}/.bin/`, "win32"),
    ).resolves.toEqual({
      entry: `${project}/agent-device/dist/src/daemon.js`,
      ok: true,
      realPath: `${project}/agent-device/bin/agent-device.mjs`,
    });
  });

  it.each([
    ["a command name ending in .cmd, looked up on PATH", "agent-device.CMD", npm],
    ["a configured path to the shim", `${npm}/agent-device.cmd`, undefined],
  ])("stands in the package's bin for %s on Windows", async (_case, command, pathVariable) => {
    const filesystem = await windowsNpmInstall();

    await expect(findAgentDevice(filesystem, command, pathVariable, "win32")).resolves.toEqual({
      entry: `${packageRoot}/dist/src/internal/daemon.js`,
      ok: true,
      realPath: `${packageRoot}/bin/agent-device.mjs`,
    });
  });

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
    await filesystem.mkdirp("/opt/bin");
    await filesystem.writeFileAtomic("/opt/bin/agent-device", "#!/bin/sh\n");
    filesystem.defineAttributes("/opt/bin/agent-device", { mode: 0o755 });

    await expect(
      findAgentDevice(filesystem, "agent-device", `/usr/bin:${npm}`, "linux"),
    ).resolves.toMatchObject({ ok: false, reason: "not-found" });
    await expect(
      findAgentDevice(filesystem, "agent-device", "/usr/bin:/opt/bin", "linux"),
    ).resolves.toMatchObject({ ok: false, reason: "not-agent-device" });
  });

  it("takes a command with a backslash as a path on Windows only", async () => {
    const filesystem = new MemoryFilesystem();
    const command = "C:\\Users\\me\\agent-device.mjs";

    await expect(findAgentDevice(filesystem, command, undefined, "win32")).resolves.toMatchObject({
      message: `agent-device not found: ${command} is not an executable file`,
    });
    await expect(findAgentDevice(filesystem, command, undefined, "linux")).resolves.toMatchObject({
      message: `agent-device not found: "${command}" is not on PATH`,
    });
  });
});

describe.runIf(process.platform === "win32")("findAgentDevice on Windows", () => {
  it("finds a local install from a PATH entry that is a project's node_modules .bin, written with backslashes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock agent-device "));
    const modules = join(directory, "node_modules");
    const packageRoot = join(modules, "agent-device");
    try {
      await mkdir(join(modules, ".bin"), { recursive: true });
      await mkdir(join(packageRoot, "bin"), { recursive: true });
      await mkdir(join(packageRoot, "dist", "src"), { recursive: true });
      await writeFile(join(modules, ".bin", "agent-device.cmd"), "@node ...");
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ bin: { "agent-device": "bin/agent-device.mjs" }, name: "agent-device" }),
      );
      await writeFile(join(packageRoot, "bin", "agent-device.mjs"), "");
      await writeFile(join(packageRoot, "dist", "src", "daemon.js"), "");

      await expect(
        findAgentDevice(new NodeFilesystem(), "agent-device", join(modules, ".bin"), "win32"),
      ).resolves.toMatchObject({
        ok: true,
        realPath: join(packageRoot, "bin", "agent-device.mjs"),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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
