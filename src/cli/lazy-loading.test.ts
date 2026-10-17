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
// a value import added back to the router or the environment builder shows up as a load the
// command never asked for.
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

async function loadsDuring(run: () => Promise<unknown>): Promise<string[]> {
  const before = new Set(loaded);
  await run();
  return [...loaded].filter((id) => !before.has(id));
}

const home = mkdtempSync(join(tmpdir(), "simlock-cli-lazy-"));

async function environment(): Promise<CliEnvironment> {
  const ports: CliEnvironmentPorts = {
    clock: new FakeClock(0),
    dataDirectory: home,
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
  it("imports the router without loading any heavy module", async () => {
    const before = new Set(loaded);
    const { runCli } = await import("./index.js");
    expect(runCli).toBeTypeOf("function");
    expect([...loaded].filter((id) => !before.has(id))).toEqual([]);
  });

  it("builds an environment without loading any heavy module", async () => {
    const before = new Set(loaded);
    await environment();
    expect([...loaded].filter((id) => !before.has(id))).toEqual([]);
  });

  it("loads no heavy module to answer --help", async () => {
    const { runCli } = await import("./index.js");
    const cli = await environment();
    expect(await loadsDuring(() => runCli(["--help"], cli))).toEqual([]);
  });

  it("loads no heavy module to answer a usage error", async () => {
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
});
