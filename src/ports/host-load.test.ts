import { mkdtemp, rm, statfs } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DarwinHostLoadProbe,
  LinuxHostLoadProbe,
  MemoryFilesystem,
  NodeFilesystem,
  NodeProcessRunner,
  productionHostLoadProbe,
  ScriptedProcessRunner,
  type CpuTimes,
} from "./index.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: vi.fn(actual.cpus) };
});

const MIB = 1024 * 1024;
const MEMSIZE = 34_359_738_368;
const SYSCTL_ARGS = [
  "-n",
  "hw.memsize",
  "kern.memorystatus_level",
  "kern.memorystatus_vm_pressure_level",
  "vm.swapusage",
];
const SWAP_LINE = "total = 2048.00M  used = 1228.75M  free = 819.25M  (encrypted)";

function sysctlOutput(
  overrides: { memsize?: string; level?: string; pressure?: string; swap?: string } = {},
): string {
  return (
    [
      overrides.memsize ?? String(MEMSIZE),
      overrides.level ?? "25",
      overrides.pressure ?? "1",
      overrides.swap ?? SWAP_LINE,
    ].join("\n") + "\n"
  );
}

function sysctlRunner(stdout: string, code: number | null = 0): ScriptedProcessRunner {
  return new ScriptedProcessRunner([
    { match: { args: SYSCTL_ARGS, command: "sysctl" }, result: { code, stderr: "", stdout } },
  ]);
}

const CORE: CpuTimes = { idle: 300, irq: 5, nice: 10, sys: 50, user: 100 };

function darwinProbe(
  processRunner: ScriptedProcessRunner,
  options: {
    cpus?: readonly { times: CpuTimes }[];
    filesystem?: MemoryFilesystem;
  } = {},
): DarwinHostLoadProbe {
  return new DarwinHostLoadProbe({
    cpus: () => options.cpus ?? [{ times: CORE }],
    dataDirectory: "/data",
    filesystem: options.filesystem ?? new MemoryFilesystem(5_000),
    processRunner,
  });
}

class SpaceFilesystem extends MemoryFilesystem {
  readonly paths: string[] = [];

  constructor(private readonly space: { freeBytes: number; totalBytes: number } | Error) {
    super();
  }

  override async diskSpace(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
    this.paths.push(path);
    if (this.space instanceof Error) throw this.space;
    return this.space;
  }
}

async function linuxFilesystem(
  files: Record<string, string>,
  space: ConstructorParameters<typeof SpaceFilesystem>[0] = { freeBytes: 120, totalBytes: 500 },
): Promise<SpaceFilesystem> {
  const filesystem = new SpaceFilesystem(space);
  await filesystem.mkdirp("/proc");
  for (const [path, contents] of Object.entries(files)) {
    await filesystem.writeFileAtomic(path, contents);
  }
  return filesystem;
}

const PROC_STAT =
  "cpu  100 10 50 300 20 5 7 3 99 98\ncpu0 50 5 25 150 10 2 3 1 49 49\ncpu1 50 5 25 150 10 3 4 2 50 49\nintr 1\n";
const PROC_MEMINFO =
  "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n";

function linuxProbe(filesystem: MemoryFilesystem): LinuxHostLoadProbe {
  return new LinuxHostLoadProbe({ cores: () => 4, dataDirectory: "/data", filesystem });
}

describe("DarwinHostLoadProbe", () => {
  it("reads total, available, swap and pressure from one bounded sysctl call, with available as hw.memsize times level over 100 and swap from the used field", async () => {
    const processRunner = sysctlRunner(sysctlOutput());

    const counters = await darwinProbe(processRunner).read();

    expect(counters.memory).toEqual({
      availableBytes: MEMSIZE / 4,
      limited: false,
      pressure: "normal",
      swapUsedBytes: 1228.75 * MIB,
      totalBytes: MEMSIZE,
    });
    expect(processRunner.calls).toHaveLength(1);
    expect(processRunner.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it.each([
    ["1", "normal"],
    ["2", "warn"],
    ["4", "critical"],
  ] as const)("maps pressure %s to %s", async (line, pressure) => {
    const counters = await darwinProbe(sysctlRunner(sysctlOutput({ pressure: line }))).read();

    expect(counters.memory?.pressure).toBe(pressure);
  });

  it.each(["3", "0", "8", "", "abc", "-1"])(
    "leaves only pressure out for the pressure line %j",
    async (line) => {
      const counters = await darwinProbe(sysctlRunner(sysctlOutput({ pressure: line }))).read();

      expect(counters.memory).toBeDefined();
      expect(counters.memory?.totalBytes).toBe(MEMSIZE);
      expect(counters.memory?.swapUsedBytes).toBe(1228.75 * MIB);
      expect(counters.memory).not.toHaveProperty("pressure");
    },
  );

  it.each([
    ["sysctl exits non-zero", sysctlOutput(), 1],
    ["sysctl times out", sysctlOutput(), null],
    ["hw.memsize is unparsable", sysctlOutput({ memsize: "n/a" }), 0],
    ["the level is unparsable", sysctlOutput({ level: "n/a" }), 0],
    ["the level is past 100", sysctlOutput({ level: "101" }), 0],
    ["the swap line is unparsable", sysctlOutput({ swap: "no swap here" }), 0],
  ] as const)(
    "leaves memory out, and still reads CPU and disk, when %s",
    async (_why, stdout, code) => {
      const filesystem = new MemoryFilesystem(5_000);
      const accepted = await darwinProbe(sysctlRunner(sysctlOutput()), { filesystem }).read();
      expect(accepted.memory).toBeDefined();

      const counters = await darwinProbe(sysctlRunner(stdout, code), { filesystem }).read();

      expect(counters.memory).toBeUndefined();
      expect(counters.cpu).toBeDefined();
      expect(counters.disk).toEqual({ freeBytes: 5_000, totalBytes: 5_000 });
    },
  );

  it("counts busy CPU time from cpus() as user, nice, sys and irq, with the core count", async () => {
    const counters = await darwinProbe(sysctlRunner(sysctlOutput()), {
      cpus: [{ times: CORE }, { times: { idle: 1_000, irq: 2, nice: 3, sys: 4, user: 5 } }],
    }).read();

    expect(counters.cpu).toEqual({
      busyTime: 100 + 10 + 50 + 5 + (5 + 3 + 4 + 2),
      cores: 2,
      limited: false,
      totalTime: 100 + 10 + 50 + 5 + 300 + (5 + 3 + 4 + 2 + 1_000),
    });
  });

  it("reads free and total disk on the data folder through diskSpace, and leaves disk out when it throws", async () => {
    const filesystem = new SpaceFilesystem({ freeBytes: 120, totalBytes: 500 });
    const counters = await darwinProbe(sysctlRunner(sysctlOutput()), { filesystem }).read();
    expect(counters.disk).toEqual({ freeBytes: 120, totalBytes: 500 });
    expect(filesystem.paths).toEqual(["/data"]);

    const failing = new SpaceFilesystem(new Error("EIO"));
    const failed = await darwinProbe(sysctlRunner(sysctlOutput()), { filesystem: failing }).read();
    expect(failed.disk).toBeUndefined();
    expect(failed.memory).toBeDefined();
    expect(failed.cpu).toBeDefined();
  });
});

describe("LinuxHostLoadProbe", () => {
  it("counts busy CPU time from /proc/stat as everything but idle and iowait, against os.cpus().length cores", async () => {
    const filesystem = await linuxFilesystem({
      "/proc/meminfo": PROC_MEMINFO,
      "/proc/stat": PROC_STAT,
    });

    const counters = await linuxProbe(filesystem).read();

    expect(counters.cpu).toEqual({
      busyTime: 100 + 10 + 50 + 5 + 7 + 3,
      cores: 4,
      limited: false,
      totalTime: 100 + 10 + 50 + 5 + 7 + 3 + 300 + 20,
    });
  });

  it("reads memory from /proc/meminfo, with limited false and no pressure, and swap used as SwapTotal minus SwapFree", async () => {
    const filesystem = await linuxFilesystem({
      "/proc/meminfo": PROC_MEMINFO,
      "/proc/stat": PROC_STAT,
    });

    const counters = await linuxProbe(filesystem).read();

    expect(counters.memory).toStrictEqual({
      availableBytes: 4_000_000 * 1024,
      limited: false,
      swapUsedBytes: 500_000 * 1024,
      totalBytes: 16_000_000 * 1024,
    });
  });

  it.each([
    ["/proc/stat is missing", { "/proc/meminfo": PROC_MEMINFO }, "cpu"],
    ["/proc/stat is unparsable", { "/proc/meminfo": PROC_MEMINFO, "/proc/stat": "nope\n" }, "cpu"],
    ["/proc/meminfo is missing", { "/proc/stat": PROC_STAT }, "memory"],
    [
      "/proc/meminfo has no MemAvailable",
      {
        "/proc/meminfo": "MemTotal: 16000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
        "/proc/stat": PROC_STAT,
      },
      "memory",
    ],
  ] as const)(
    "leaves out the part whose file is wrong, and still reads the others: %s",
    async (_why, files, left) => {
      const accepted = await linuxProbe(
        await linuxFilesystem({ "/proc/meminfo": PROC_MEMINFO, "/proc/stat": PROC_STAT }),
      ).read();
      expect(accepted.cpu).toBeDefined();
      expect(accepted.memory).toBeDefined();

      const counters = await linuxProbe(await linuxFilesystem(files)).read();

      expect(counters[left]).toBeUndefined();
      const other = left === "cpu" ? "memory" : "cpu";
      expect(counters[other]).toBeDefined();
      expect(counters.disk).toEqual({ freeBytes: 120, totalBytes: 500 });
    },
  );

  it("reads free and total disk on the data folder through diskSpace, and leaves disk out when it throws", async () => {
    const files = { "/proc/meminfo": PROC_MEMINFO, "/proc/stat": PROC_STAT };
    const filesystem = await linuxFilesystem(files);
    const counters = await linuxProbe(filesystem).read();
    expect(counters.disk).toEqual({ freeBytes: 120, totalBytes: 500 });
    expect(filesystem.paths).toEqual(["/data"]);

    const failed = await linuxProbe(await linuxFilesystem(files, new Error("EIO"))).read();
    expect(failed.disk).toBeUndefined();
    expect(failed.cpu).toBeDefined();
    expect(failed.memory).toBeDefined();
  });
});

describe("NodeFilesystem.diskSpace", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("answers free and total bytes for a real folder, with total not below free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-disk-space-"));
    directories.push(directory);

    const { freeBytes, totalBytes } = await new NodeFilesystem().diskSpace(directory);

    expect(freeBytes).toBeGreaterThan(0);
    expect(totalBytes).toBeGreaterThanOrEqual(freeBytes);
    const details = await statfs(directory);
    expect(totalBytes).toBe(details.blocks * details.bsize);
  });
});

describe("productionHostLoadProbe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the macOS probe on darwin and the Linux probe elsewhere", () => {
    expect(productionHostLoadProbe({ dataDirectory: tmpdir(), platform: "darwin" })).toBeInstanceOf(
      DarwinHostLoadProbe,
    );
    for (const platform of ["linux", "freebsd"] as const) {
      expect(productionHostLoadProbe({ dataDirectory: tmpdir(), platform })).toBeInstanceOf(
        LinuxHostLoadProbe,
      );
    }
  });

  it("gives the macOS probe a NodeProcessRunner of its own, which runs sysctl", async () => {
    const run = vi
      .spyOn(NodeProcessRunner.prototype, "run")
      .mockResolvedValue({ code: 0, stderr: "", stdout: sysctlOutput() });

    const counters = await productionHostLoadProbe({
      dataDirectory: tmpdir(),
      platform: "darwin",
    }).read();

    expect(run).toHaveBeenCalledWith("sysctl", SYSCTL_ARGS, expect.anything());
    expect(counters.memory?.totalBytes).toBe(MEMSIZE);
  });

  it("counts the Linux probe's cores from os.cpus().length", async () => {
    vi.mocked(cpus).mockReturnValue(
      Array.from({ length: 3 }, () => ({}) as ReturnType<typeof cpus>[number]),
    );
    vi.spyOn(NodeFilesystem.prototype, "readFile").mockImplementation(async (path: string) =>
      path === "/proc/stat" ? "cpu  10 0 10 80 0 0 0 0 0 0\n" : "",
    );

    const counters = await productionHostLoadProbe({
      dataDirectory: tmpdir(),
      platform: "linux",
    }).read();

    expect(counters.cpu).toStrictEqual({ busyTime: 20, cores: 3, limited: false, totalTime: 100 });
  });
});
