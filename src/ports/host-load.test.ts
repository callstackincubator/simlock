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
  type HostLoadCounters,
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
  return new LinuxHostLoadProbe({
    cores: () => 4,
    dataDirectory: "/data",
    filesystem,
    nowMicros: () => 10_000_000,
  });
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

const GIB = 1024 ** 3;
const CGROUP_ROOT = "/sys/fs/cgroup";
const BIG_MEMINFO =
  "MemTotal:       67108864 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n";
const MACHINE_MEMORY = {
  availableBytes: 4_000_000 * 1024,
  limited: false,
  swapUsedBytes: 500_000 * 1024,
  totalBytes: 67_108_864 * 1024,
};

interface CgroupFolder {
  readonly cpuMax?: string;
  readonly memoryMax?: string;
  readonly cpuStat?: string;
  readonly current?: string;
  readonly stat?: string;
  readonly swap?: string;
}

function folderFiles(folder: string, values: CgroupFolder): Record<string, string> {
  const base = folder === "" ? CGROUP_ROOT : `${CGROUP_ROOT}/${folder}`;
  const entries: [string, string | undefined][] = [
    ["cpu.max", values.cpuMax],
    ["memory.max", values.memoryMax],
    ["cpu.stat", values.cpuStat],
    ["memory.current", values.current],
    ["memory.stat", values.stat],
    ["memory.swap.current", values.swap],
  ];
  const files: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (value !== undefined) files[`${base}/${name}`] = value;
  }
  return files;
}

const USAGE = {
  cpuStat: "usage_usec 5000000\nuser_usec 3000000\nsystem_usec 2000000\n",
  current: "5368709120\n",
  stat: "anon 1\ninactive_file 2147483648\nactive_file 5\n",
};

async function cgroupFilesystem(
  cgroupLine: string | undefined,
  files: Record<string, string>,
): Promise<SpaceFilesystem> {
  const filesystem = new SpaceFilesystem({ freeBytes: 120, totalBytes: 500 });
  const all: Record<string, string> = {
    "/proc/meminfo": BIG_MEMINFO,
    "/proc/stat": PROC_STAT,
    ...(cgroupLine === undefined ? {} : { "/proc/self/cgroup": cgroupLine }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")) || "/");
    await filesystem.writeFileAtomic(path, contents);
  }
  return filesystem;
}

function cgroupProbe(
  filesystem: MemoryFilesystem,
  options: { cores?: number; now?: () => number } = {},
): LinuxHostLoadProbe {
  return new LinuxHostLoadProbe({
    cores: () => options.cores ?? 64,
    dataDirectory: "/data",
    filesystem,
    nowMicros: options.now ?? (() => 10_000_000),
  });
}

async function readCgroup(
  path: string,
  folders: Record<string, CgroupFolder>,
  options: { cores?: number; now?: () => number } = {},
): Promise<HostLoadCounters> {
  const files: Record<string, string> = {};
  for (const [folder, values] of Object.entries(folders)) {
    Object.assign(files, folderFiles(folder, values));
  }
  const filesystem = await cgroupFilesystem(`0::${path}\n`, files);
  return cgroupProbe(filesystem, options).read();
}

const LIMITED_TWO_CORES = { cores: 2, limited: true, busyTime: 5_000_000, totalTime: 20_000_000 };
const LIMITED_EIGHT_GIB = {
  availableBytes: 5 * GIB,
  limited: true,
  swapUsedBytes: 0,
  totalBytes: 8 * GIB,
};

describe("LinuxHostLoadProbe under cgroup v2 limits", () => {
  it("reports cores as the cpu.max quota over its period, and CPU time from cpu.stat against elapsed time, as limited", async () => {
    const counters = await readCgroup("/docker/abc", {
      "docker/abc": { cpuMax: "200000 100000\n", ...USAGE },
    });

    expect(counters.cpu).toStrictEqual(LIMITED_TWO_CORES);
  });

  it.each([
    ["1000 100000", 0.01, 100_000],
    ["1000 1000000", 0.001, 10_000],
  ] as const)(
    "reports a quota of %s as fractional cores, limited",
    async (cpuMax, cores, totalTime) => {
      const counters = await readCgroup("/x", { x: { cpuMax: `${cpuMax}\n`, ...USAGE } });

      expect(counters.cpu).toMatchObject({ cores, limited: true, totalTime });
    },
  );

  it("uses /sys/fs/cgroup itself for a 0::/ line", async () => {
    const counters = await readCgroup("/", {
      "": { cpuMax: "150000 100000\n", memoryMax: "max\n", ...USAGE },
      x: { cpuMax: "100000 100000\n", ...USAGE },
    });

    expect(counters.cpu).toMatchObject({ cores: 1.5, limited: true });
    expect(counters.memory).toStrictEqual(MACHINE_MEMORY);
  });

  it("takes the lowest CPU and the lowest memory limit across Simlock's folder and its parents, comparing CPU limits as cores", async () => {
    const memory = await readCgroup("/system.slice/simlock.service", {
      "": { cpuMax: "max 100000\n" },
      "system.slice": { memoryMax: "8589934592\n", ...USAGE },
      "system.slice/simlock.service": {
        memoryMax: "17179869184\n",
        current: "1\n",
        stat: "inactive_file 0\n",
      },
    });
    expect(memory.memory).toStrictEqual(LIMITED_EIGHT_GIB);
    expect(memory.cpu).toStrictEqual({
      busyTime: 175,
      cores: 64,
      limited: false,
      totalTime: 495,
    });

    const cpu = await readCgroup("/x", {
      x: { cpuMax: "200000 100000\n", ...USAGE },
      "": { cpuMax: "150000 50000\n" },
    });
    expect(cpu.cpu).toMatchObject({ cores: 2, limited: true });

    const folderLower = await readCgroup("/system.slice/simlock.service", {
      "system.slice": { memoryMax: "8589934592\n", current: "1\n", stat: "inactive_file 0\n" },
      "system.slice/simlock.service": {
        memoryMax: "4294967296\n",
        current: "1073741824\n",
        stat: "inactive_file 0\n",
      },
    });
    expect(folderLower.memory).toMatchObject({
      availableBytes: 3 * GIB,
      limited: true,
      totalBytes: 4 * GIB,
    });
  });

  it("reports the folder's memory.max of 16 GiB as limited when cpu.max is max everywhere, and keeps the machine's CPU", async () => {
    const counters = await readCgroup("/system.slice/simlock.service", {
      "": { cpuMax: "max 100000\n" },
      "system.slice/simlock.service": {
        cpuMax: "max 100000\n",
        memoryMax: "17179869184\n",
        ...USAGE,
      },
    });

    expect(counters.memory).toStrictEqual({
      availableBytes: 13 * GIB,
      limited: true,
      swapUsedBytes: 0,
      totalBytes: 16 * GIB,
    });
    expect(counters.cpu).toMatchObject({ cores: 64, limited: false });
  });

  it("reads usage from the folder that holds the winning limit, not from Simlock's own folder, and from the topmost of two folders tied on the lowest limit", async () => {
    const winner = await readCgroup("/a/b/c", {
      a: { cpuMax: "200000 100000\n", memoryMax: "8589934592\n", ...USAGE },
      "a/b": { cpuMax: "400000 100000\n" },
      "a/b/c": {
        cpuMax: "400000 100000\n",
        cpuStat: "usage_usec 1\n",
        current: "1\n",
        stat: "inactive_file 0\n",
      },
    });
    expect(winner.cpu).toStrictEqual(LIMITED_TWO_CORES);
    expect(winner.memory).toStrictEqual(LIMITED_EIGHT_GIB);

    const tied = await readCgroup("/a/b", {
      a: { cpuMax: "200000 100000\n", memoryMax: "8589934592\n", ...USAGE },
      "a/b": {
        cpuMax: "200000 100000\n",
        memoryMax: "8589934592\n",
        cpuStat: "usage_usec 1\n",
        current: "1\n",
        stat: "inactive_file 0\n",
      },
    });
    expect(tied.cpu).toStrictEqual(LIMITED_TWO_CORES);
    expect(tied.memory).toStrictEqual(LIMITED_EIGHT_GIB);
  });

  it("reads only /sys/fs/cgroup for a cgroup path with a .. segment", async () => {
    const counters = await readCgroup("/../../system.slice/x", {
      "": { cpuMax: "200000 100000\n", ...USAGE },
      "system.slice/x": { cpuMax: "100000 100000\n", ...USAGE },
      "../../system.slice/x": { cpuMax: "100000 100000\n", ...USAGE },
    });

    expect(counters.cpu).toStrictEqual(LIMITED_TWO_CORES);
  });

  it("accepts cpu.max and memory.max with the kernel's trailing newline, and nothing else after the value", async () => {
    const folders = {
      x: { cpuMax: "200000 100000\n", memoryMax: "8589934592\n", ...USAGE, swap: "1048576\n" },
    };
    const accepted = await readCgroup("/x", folders);
    expect(accepted.cpu).toStrictEqual(LIMITED_TWO_CORES);
    expect(accepted.memory).toMatchObject({ limited: true, swapUsedBytes: 1_048_576 });

    const extra = await readCgroup("/x", {
      x: { ...folders.x, cpuMax: "200000 100000\n\n", memoryMax: "8589934592\n\n" },
    });
    expect(extra.cpu).toMatchObject({ limited: false });
    expect(extra.memory).toStrictEqual(MACHINE_MEMORY);
  });

  it.each([
    "garbage\n",
    "200000\n",
    "200000 0\n",
    "-1 100000\n",
    "max 100000\n",
    "200000  100000\n",
  ])("treats cpu.max %j as no limit at that level", async (value) => {
    const accepted = await readCgroup("/x", {
      "": { cpuMax: "300000 100000\n", ...USAGE },
      x: { cpuMax: "200000 100000\n", ...USAGE },
    });
    expect(accepted.cpu).toMatchObject({ cores: 2, limited: true });

    const counters = await readCgroup("/x", {
      "": { cpuMax: "300000 100000\n", ...USAGE },
      x: { cpuMax: value },
    });

    expect(counters.cpu).toMatchObject({ cores: 3, limited: true });
  });

  it("reports the machine's CPU, not limited, for a quota at or above the machine's cores", async () => {
    const folders = { x: { cpuMax: "300000 100000\n", ...USAGE } };
    const below = await readCgroup("/x", folders, { cores: 4 });
    expect(below.cpu).toMatchObject({ cores: 3, limited: true });

    const counters = await readCgroup(
      "/x",
      { x: { cpuMax: "800000 100000\n", ...USAGE } },
      { cores: 4 },
    );

    expect(counters.cpu).toMatchObject({ cores: 4, limited: false });

    const equal = await readCgroup(
      "/x",
      { x: { cpuMax: "400000 100000\n", ...USAGE } },
      { cores: 4 },
    );
    expect(equal.cpu).toMatchObject({ cores: 4, limited: false });
    expect(counters.cpu?.totalTime).toBe(100 + 10 + 50 + 5 + 7 + 3 + 300 + 20);
  });

  it.each([
    ["cpu.stat is missing", { cpuMax: "200000 100000\n" }],
    ["cpu.stat has no usage_usec", { cpuMax: "200000 100000\n", cpuStat: "user_usec 1\n" }],
  ])("leaves CPU out under a CPU limit when %s", async (_why, folder) => {
    const accepted = await readCgroup("/x", { x: { cpuMax: "200000 100000\n", ...USAGE } });
    expect(accepted.cpu).toBeDefined();

    const counters = await readCgroup("/x", { x: folder });

    expect(counters.cpu).toBeUndefined();
    expect(counters.memory).toBeDefined();
  });

  it("reports memory total as the limit, and available as the limit minus memory.current plus inactive_file, floored at 0, as limited", async () => {
    const counters = await readCgroup("/x", { x: { memoryMax: "8589934592\n", ...USAGE } });
    expect(counters.memory).toStrictEqual(LIMITED_EIGHT_GIB);

    const over = await readCgroup("/x", {
      x: { memoryMax: "8589934592\n", current: "10737418240\n", stat: "inactive_file 0\n" },
    });
    expect(over.memory).toStrictEqual({ ...LIMITED_EIGHT_GIB, availableBytes: 0 });
  });

  it("reports swap used as memory.swap.current under a memory limit, and 0 when that file is missing", async () => {
    const withSwap = await readCgroup("/x", {
      x: { memoryMax: "8589934592\n", ...USAGE, swap: "123456\n" },
    });
    expect(withSwap.memory).toMatchObject({ limited: true, swapUsedBytes: 123_456 });

    const without = await readCgroup("/x", { x: { memoryMax: "8589934592\n", ...USAGE } });
    expect(without.memory).toMatchObject({ limited: true, swapUsedBytes: 0 });
  });

  it.each([
    ["max", "max\n"],
    ["a value above MemTotal", "1099511627776\n"],
    ["a value equal to MemTotal", "68719476736\n"],
    ["an unparsable file", "garbage\n"],
  ])("reports the machine's memory, not limited, for memory.max %s", async (_why, value) => {
    const accepted = await readCgroup("/x", { x: { memoryMax: "8589934592\n", ...USAGE } });
    expect(accepted.memory?.limited).toBe(true);

    const counters = await readCgroup("/x", { x: { memoryMax: value, ...USAGE } });

    expect(counters.memory).toStrictEqual(MACHINE_MEMORY);
  });

  it("leaves memory out under a memory limit when memory.current or inactive_file cannot be read, and keeps the limit when /proc/meminfo cannot be read", async () => {
    const limit = { memoryMax: "8589934592\n" };
    const noCurrent = await readCgroup("/x", { x: { ...limit, stat: USAGE.stat } });
    expect(noCurrent.memory).toBeUndefined();
    const noInactive = await readCgroup("/x", {
      x: { ...limit, current: USAGE.current, stat: "anon 1\n" },
    });
    expect(noInactive.memory).toBeUndefined();
    const noStat = await readCgroup("/x", { x: { ...limit, current: USAGE.current } });
    expect(noStat.memory).toBeUndefined();

    const filesystem = await cgroupFilesystem("0::/x\n", folderFiles("x", { ...limit, ...USAGE }));
    await filesystem.rm("/proc/meminfo");
    const counters = await cgroupProbe(filesystem).read();
    expect(counters.memory).toStrictEqual(LIMITED_EIGHT_GIB);
  });

  it("decides the CPU and memory limits independently", async () => {
    const counters = await readCgroup("/a/b", {
      a: { cpuMax: "200000 100000\n", ...USAGE },
      "a/b": { memoryMax: "8589934592\n", ...USAGE },
    });

    expect(counters.cpu).toStrictEqual(LIMITED_TWO_CORES);
    expect(counters.memory).toStrictEqual(LIMITED_EIGHT_GIB);
  });

  it.each([
    ["a cgroup path with files missing", "0::/user.slice/x\n"],
    ["v1 lines only", "12:cpu,cpuacct:/docker/abc\n1:name=systemd:/docker/abc\n"],
    ["unreadable", undefined],
  ])("reports the machine's figures when /proc/self/cgroup is %s", async (_why, line) => {
    const files = folderFiles("docker/abc", {
      cpuMax: "200000 100000\n",
      memoryMax: "8589934592\n",
      ...USAGE,
    });
    const accepted = await cgroupFilesystem("0::/docker/abc\n", files);
    expect((await cgroupProbe(accepted).read()).cpu?.limited).toBe(true);

    const counters = await cgroupProbe(await cgroupFilesystem(line, files)).read();

    expect(counters.cpu).toMatchObject({ cores: 64, limited: false });
    expect(counters.memory).toStrictEqual(MACHINE_MEMORY);
  });

  it("reports the machine's figures when /proc/self/cgroup has only cgroup v1 lines and no 0:: line", async () => {
    const files = folderFiles("docker/abc", {
      cpuMax: "200000 100000\n",
      memoryMax: "8589934592\n",
      ...USAGE,
    });
    const accepted = await cgroupFilesystem("12:memory:/docker/abc\n0::/docker/abc\n", files);
    expect((await cgroupProbe(accepted).read()).cpu?.limited).toBe(true);

    const counters = await cgroupProbe(
      await cgroupFilesystem(
        "12:memory:/docker/abc\n10::/docker/abc\n1:name=systemd:/docker/abc\n",
        files,
      ),
    ).read();

    expect(counters.cpu).toMatchObject({ cores: 64, limited: false });
    expect(counters.memory).toStrictEqual(MACHINE_MEMORY);
  });

  it("shows a limit seeded between two reads on the second read, drops one removed between reads, and follows /proc/self/cgroup to a new folder between reads", async () => {
    const filesystem = await cgroupFilesystem("0::/a\n", {});
    const probe = cgroupProbe(filesystem);
    expect((await probe.read()).cpu?.limited).toBe(false);

    for (const [path, contents] of Object.entries(
      folderFiles("a", { cpuMax: "200000 100000\n", ...USAGE }),
    )) {
      await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
      await filesystem.writeFileAtomic(path, contents);
    }
    expect((await probe.read()).cpu).toStrictEqual(LIMITED_TWO_CORES);

    for (const [path, contents] of Object.entries(
      folderFiles("b", { cpuMax: "100000 100000\n", ...USAGE }),
    )) {
      await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
      await filesystem.writeFileAtomic(path, contents);
    }
    await filesystem.writeFileAtomic("/proc/self/cgroup", "0::/b\n");
    expect((await probe.read()).cpu).toMatchObject({ cores: 1, limited: true });

    await filesystem.rm(`${CGROUP_ROOT}/b/cpu.max`);
    expect((await probe.read()).cpu).toMatchObject({ cores: 64, limited: false });
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

  it("advances the Linux probe's nowMicros by about one million per second of process.hrtime", async () => {
    const hrtime = vi.spyOn(process.hrtime, "bigint");
    vi.mocked(cpus).mockReturnValue(
      Array.from({ length: 4 }, () => ({}) as ReturnType<typeof cpus>[number]),
    );
    vi.spyOn(NodeFilesystem.prototype, "readFile").mockImplementation(async (path: string) => {
      if (path === "/proc/self/cgroup") return "0::/x\n";
      if (path === `${CGROUP_ROOT}/x/cpu.max`) return "200000 100000\n";
      if (path === `${CGROUP_ROOT}/x/cpu.stat`) return "usage_usec 1\n";
      if (path === "/proc/stat") return "cpu  10 0 10 80 0 0 0 0 0 0\n";
      throw new Error("ENOENT");
    });
    const probe = productionHostLoadProbe({ dataDirectory: tmpdir(), platform: "linux" });

    hrtime.mockReturnValue(5_000_000_000n);
    const first = await probe.read();
    hrtime.mockReturnValue(7_000_000_000n);
    const second = await probe.read();

    expect(first.cpu).toMatchObject({ cores: 2, limited: true, totalTime: 10_000_000 });
    expect(second.cpu).toMatchObject({ totalTime: 14_000_000 });
  });

  it.runIf(process.platform === "linux")(
    "on Linux, the production Linux probe returns CPU counters, memory and disk from the real /proc and /sys",
    async () => {
      vi.restoreAllMocks();
      vi.mocked(cpus).mockImplementation(
        (await vi.importActual<typeof import("node:os")>("node:os")).cpus,
      );

      const counters = await productionHostLoadProbe({
        dataDirectory: tmpdir(),
        platform: "linux",
      }).read();

      expect(counters.cpu?.cores).toBeGreaterThan(0);
      expect(counters.cpu?.totalTime).toBeGreaterThan(0);
      expect(counters.memory?.totalBytes).toBeGreaterThan(0);
      expect(counters.disk?.totalBytes).toBeGreaterThan(0);
    },
  );
});
