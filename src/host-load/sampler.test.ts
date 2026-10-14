import { describe, expect, it } from "vitest";

import {
  FakeClock,
  FakeHostLoadProbe,
  type HostLoadCounters,
  JsonLinesLogger,
  MemoryLogSink,
} from "../ports/index.js";
import { HostLoadSampler } from "./index.js";

const MEMORY = {
  availableBytes: 4_000,
  limited: false,
  swapUsedBytes: 100,
  totalBytes: 16_000,
};
const DISK = { freeBytes: 120, totalBytes: 500 };

function cpuPart(busyTime: number, totalTime: number, cores = 4, limited = false) {
  return { busyTime, cores, limited, totalTime };
}

function counters(
  busyTime: number,
  totalTime: number,
  extra: Partial<HostLoadCounters> & { cores?: number; limited?: boolean } = {},
): HostLoadCounters {
  const { cores, limited, ...parts } = extra;
  return {
    cpu: cpuPart(busyTime, totalTime, cores, limited),
    disk: DISK,
    memory: MEMORY,
    ...parts,
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function harness() {
  const clock = new FakeClock(1_000);
  const sink = new MemoryLogSink();
  const probe = new FakeHostLoadProbe();
  const sampler = new HostLoadSampler({
    clock,
    logger: new JsonLinesLogger({ clock, level: "debug", sink }),
    probe,
  });
  const warnings = () => sink.records.filter((record) => record.level === "warn");
  const settle = async (answer: HostLoadCounters | Error): Promise<void> => {
    probe.answer(answer);
    await flush();
  };
  const tick = async (answer: HostLoadCounters | Error): Promise<void> => {
    clock.advance(15_000);
    await settle(answer);
  };
  return { clock, probe, sampler, settle, sink, tick, warnings };
}

describe("HostLoadSampler", () => {
  it("reads at start, then every 15 s, and skips a tick while a read is in flight", async () => {
    const { clock, probe, sampler, settle } = harness();

    sampler.start();
    expect(probe.reads).toBe(1);
    await settle(counters(0, 100));

    clock.advance(14_999);
    expect(probe.reads).toBe(1);
    clock.advance(1);
    expect(probe.reads).toBe(2);

    clock.advance(15_000);
    expect(probe.reads).toBe(2);

    await settle(counters(10, 200));
    clock.advance(15_000);
    expect(probe.reads).toBe(3);
    sampler.dispose();
  });

  it("keeps the 15 s beat when a read takes a few seconds", async () => {
    const { clock, probe, sampler, settle } = harness();
    sampler.start();
    await settle(counters(0, 100));

    clock.advance(15_000);
    expect(probe.reads).toBe(2);
    clock.advance(4_000);
    await settle(counters(10, 200));
    clock.advance(10_999);
    expect(probe.reads).toBe(2);
    clock.advance(1);
    expect(probe.reads).toBe(3);
    sampler.dispose();
  });

  it("gives up on a read after 10 s, ignores its late answer, and starts no other read until it settles", async () => {
    const { clock, probe, sampler, settle } = harness();
    sampler.start();
    await settle(counters(0, 100));
    expect(sampler.current()?.memory).toEqual(MEMORY);

    clock.advance(15_000);
    expect(probe.reads).toBe(2);
    clock.advance(9_999);
    expect(sampler.current()?.memory).toEqual(MEMORY);
    clock.advance(1);
    await flush();
    const given = sampler.current();
    expect(given).toBeDefined();
    expect(given?.cpu).toBeUndefined();
    expect(given?.memory).toBeUndefined();
    expect(given?.disk).toBeUndefined();

    clock.advance(30_000);
    expect(probe.reads).toBe(2);

    await settle(counters(50, 300));
    expect(sampler.current()?.memory).toBeUndefined();
    clock.advance(15_000);
    expect(probe.reads).toBe(3);
    await settle(counters(60, 400));
    expect(sampler.current()?.memory).toEqual(MEMORY);
    sampler.dispose();
  });

  it("computes busy % from two successive reads, and has no CPU after the first read", async () => {
    const { sampler, settle, tick } = harness();
    sampler.start();
    await settle(counters(100, 1_000));

    const first = sampler.current();
    expect(first?.memory).toEqual(MEMORY);
    expect(first?.cpu).toBeUndefined();

    await tick(counters(150, 1_100));

    expect(sampler.current()?.cpu).toEqual({ busyPercent: 50, cores: 4, limited: false });
    sampler.dispose();
  });

  it.each([
    ["the total did not move", counters(160, 1_100)],
    ["the total went back", counters(160, 1_000)],
    ["the core count changed", counters(200, 1_200, { cores: 8 })],
    ["limited changed", counters(200, 1_200, { limited: true })],
  ])("leaves CPU out when %s", async (_why, third) => {
    const { sampler, settle, tick } = harness();
    sampler.start();
    await settle(counters(100, 1_000));
    await tick(counters(150, 1_100));
    expect(sampler.current()?.cpu?.busyPercent).toBe(50);

    await tick(third);

    expect(sampler.current()).toBeDefined();
    expect(sampler.current()?.cpu).toBeUndefined();
    expect(sampler.current()?.memory).toEqual(MEMORY);
    sampler.dispose();
  });

  it("clamps busy % to 0-100", async () => {
    const { sampler, settle, tick } = harness();
    sampler.start();
    await settle(counters(100, 1_000));

    await tick(counters(300, 1_100));
    expect(sampler.current()?.cpu?.busyPercent).toBe(100);

    await tick(counters(250, 1_200));
    expect(sampler.current()?.cpu?.busyPercent).toBe(0);
    sampler.dispose();
  });

  it("never carries a part forward: one that fails is absent from that reading", async () => {
    const { sampler, settle, tick } = harness();
    sampler.start();
    await settle(counters(100, 1_000));
    await tick(counters(150, 1_100));
    expect(sampler.current()).toMatchObject({
      cpu: { busyPercent: 50 },
      disk: DISK,
      memory: MEMORY,
    });

    await tick({ cpu: cpuPart(160, 1_200), disk: DISK });

    const reading = sampler.current();
    expect(reading?.memory).toBeUndefined();
    expect(reading?.cpu?.busyPercent).toBe(10);
    expect(reading?.disk).toEqual(DISK);

    await tick({ cpu: cpuPart(170, 1_300), memory: MEMORY });
    expect(sampler.current()?.disk).toBeUndefined();
    expect(sampler.current()?.memory).toEqual(MEMORY);
    sampler.dispose();
  });

  it("logs nothing for a part never read, one warn when a read part fails, and one when it is read again", async () => {
    const { sampler, settle, tick, warnings } = harness();
    sampler.start();
    await settle({ cpu: cpuPart(100, 1_000), disk: DISK });
    await tick({ cpu: cpuPart(110, 1_100), disk: DISK });
    expect(warnings()).toEqual([]);

    await tick(counters(120, 1_200));
    expect(sampler.current()?.memory).toEqual(MEMORY);
    expect(warnings()).toEqual([]);

    await tick({ cpu: cpuPart(130, 1_300), disk: DISK });
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(warnings()[0])).toContain("memory");

    await tick({ cpu: cpuPart(140, 1_400), disk: DISK });
    expect(warnings()).toHaveLength(1);

    await tick(counters(150, 1_500));
    expect(warnings()).toHaveLength(2);
    expect(JSON.stringify(warnings()[1])).toContain("memory");
    sampler.dispose();
  });

  it("logs no CPU warn for a reading that has CPU counters but no busy %", async () => {
    const { sampler, settle, tick, warnings } = harness();
    sampler.start();
    await settle(counters(100, 1_000));
    expect(sampler.current()?.cpu).toBeUndefined();
    await tick(counters(150, 1_100));
    expect(sampler.current()?.cpu?.busyPercent).toBe(50);

    await tick(counters(150, 1_100));
    expect(sampler.current()?.cpu).toBeUndefined();
    await tick(counters(200, 1_200, { cores: 8 }));
    expect(sampler.current()?.cpu).toBeUndefined();

    expect(warnings()).toEqual([]);
    sampler.dispose();
  });

  it("treats a probe that rejects as a failed read, logs it once, and reads again on the next tick", async () => {
    const { probe, sampler, settle, tick, warnings } = harness();
    sampler.start();

    await settle(new Error("sysctl exploded"));

    const reading = sampler.current();
    expect(reading).toBeDefined();
    expect(reading?.cpu).toBeUndefined();
    expect(reading?.memory).toBeUndefined();
    expect(reading?.disk).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(warnings()[0])).toContain("sysctl exploded");

    await tick(counters(0, 100));
    expect(probe.reads).toBe(2);
    expect(sampler.current()?.memory).toEqual(MEMORY);
    sampler.dispose();
  });

  it("treats a probe whose read throws synchronously as a failed read, logs it once, and reads again", async () => {
    const { probe, sampler, tick, warnings } = harness();
    const read = probe.read.bind(probe);
    let throwing = true;
    probe.read = () => {
      if (throwing) throw new Error("spawn exploded");
      return read();
    };
    sampler.start();
    await flush();

    expect(sampler.current()).toBeDefined();
    expect(sampler.current()?.memory).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(JSON.stringify(warnings()[0])).toContain("spawn exploded");

    throwing = false;
    await tick(counters(0, 100));
    expect(sampler.current()?.memory).toEqual(MEMORY);
    sampler.dispose();
  });

  it("reports ageMs as the time since the read, 0 when the clock stepped back, and nothing before the first read finishes", async () => {
    const { clock, sampler, settle } = harness();
    sampler.start();
    expect(sampler.current()).toBeUndefined();

    await settle(counters(0, 100));
    expect(sampler.current()?.ageMs).toBe(0);

    clock.advance(4_000);
    expect(sampler.current()?.ageMs).toBe(4_000);

    clock.advance(-10_000);
    expect(sampler.current()?.ageMs).toBe(0);
    sampler.dispose();
  });

  it("holds no timer after dispose(), and a read in flight changes nothing and logs nothing", async () => {
    const { clock, probe, sampler, settle, warnings } = harness();
    sampler.start();
    await settle(counters(0, 100));
    expect(clock.pendingTimerCount).toBeGreaterThan(0);

    clock.advance(15_000);
    expect(probe.reads).toBe(2);
    sampler.dispose();
    expect(clock.pendingTimerCount).toBe(0);

    await settle({ cpu: cpuPart(10, 200), disk: DISK });
    expect(sampler.current()?.memory).toEqual(MEMORY);
    expect(warnings()).toEqual([]);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
