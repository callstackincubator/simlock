import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CliEnvironment, CliEnvironmentPorts } from "./types.js";
import {
  FakeClock,
  FakeDaemonLauncher,
  FakeSystemStats,
  MemoryFilesystem,
  MemoryIpcTransport,
} from "../ports/index.js";

// why: each mock passes its module through untouched and only records the first real import, so
// a command's load is measured rather than assumed. The static half of the same claim -- that the
// router's own files never import a component for a value -- is enforced in one place by the
// dependency rule `cli-router-imports-no-component-values`, not here.
const loaded = vi.hoisted(() => new Set<string>());

vi.mock("../core/index.js", async (importOriginal) => {
  loaded.add("core");
  return await importOriginal();
});
vi.mock("../module-registry/index.js", async (importOriginal) => {
  loaded.add("module-registry");
  return await importOriginal();
});
vi.mock("../lease-policy/index.js", async (importOriginal) => {
  loaded.add("lease-policy");
  return await importOriginal();
});
vi.mock("../admin/index.js", async (importOriginal) => {
  loaded.add("admin");
  return await importOriginal();
});
vi.mock("../bus/index.js", async (importOriginal) => {
  loaded.add("bus");
  return await importOriginal();
});
vi.mock("../contract/index.js", async (importOriginal) => {
  loaded.add("contract");
  return await importOriginal();
});
vi.mock("../ports/index.js", async (importOriginal) => {
  loaded.add("ports");
  return await importOriginal();
});

async function loadsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const before = new Set(loaded);
  await run();
  return [...loaded].filter((id) => !before.has(id));
}

const home = mkdtempSync(join(tmpdir(), "simlock-cli-lazy-"));

async function environment(): Promise<CliEnvironment> {
  const ports: CliEnvironmentPorts = {
    clock: new FakeClock(0),
    daemonHome: { role: "worker", dataDirectory: home, gatewayPresent: false },
    homeDirectory: "/home/operator",
    workingDirectory: "/work/project",
    runTool: async () => ({ outcome: "not-found" }),
    filesystem: new MemoryFilesystem(),
    ipc: new MemoryIpcTransport(),
    launcher: new FakeDaemonLauncher(),
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
  };
  const { buildCliEnvironment } = await import("./environment.js");
  return buildCliEnvironment(ports, {});
}

describe("the CLI loads what a command asks for, not the whole control plane", () => {
  it("loads no heavy component to answer --help", async () => {
    const { runCli } = await import("./index.js");
    const cli = await environment();
    expect(await loadsDuring(() => runCli(["--help"], cli))).toEqual([]);
  });

  it("loads no heavy component to answer -h", async () => {
    const { runCli } = await import("./index.js");
    const cli = await environment();
    expect(await loadsDuring(() => runCli(["-h"], cli))).toEqual([]);
  });

  it("loads no heavy component to answer a usage error", async () => {
    const { runCli } = await import("./index.js");
    const cli = await environment();
    expect(await loadsDuring(() => runCli(["bogus"], cli))).toEqual([]);
  });

  it("loads the config modules for the one command that validates a config file", async () => {
    // why: `config set` never connects, so everything it loads comes from validating the merge.
    const { runCli } = await import("./index.js");
    const cli = await environment();
    const loads = await loadsDuring(() => runCli(["config", "set", "leaseTtlMs", "60000"], cli));
    expect(loads).toEqual(expect.arrayContaining(["core", "module-registry"]));
    expect(loads).not.toContain("admin");
    expect(loads).not.toContain("lease-policy");
  });

  it("loads a runnable module for every node of the command tree", async () => {
    // why: the tree's thunks are the only seam between a command word and its module, so a node
    // that points at a missing or mis-shaped module must fail here, not when a person runs it.
    const { COMMANDS } = await import("./tree.js");
    const nodes = COMMANDS.flatMap((node) => [node, ...(node.children ?? [])]);
    expect(nodes.length).toBeGreaterThan(COMMANDS.length);
    for (const node of nodes) {
      const module = await node.load();
      expect(module.run, node.name).toBeTypeOf("function");
    }
  });
});
