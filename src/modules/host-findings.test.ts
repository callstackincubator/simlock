import { describe, expect, it } from "vitest";

import { loadConfig } from "../core/index.js";
import { FakeSystemStats, MemoryFilesystem, NoopLogger } from "../ports/index.js";
import { createModuleHost, type ModuleFinding } from "./index.js";
import { fakeModule, fakeModuleTokens, fakeWorkerContext } from "./testing.js";

const FINDINGS_DEADLINE_MS = 10_000;

const finding = (message: string): ModuleFinding => ({ message, remedy: "fix it" });

async function hostOf(
  findings: Readonly<
    Record<string, () => readonly ModuleFinding[] | Promise<readonly ModuleFinding[]>>
  >,
) {
  const fakes = Object.entries(findings).map(
    ([name, read]) => fakeModule({ findings: read, name }).definition,
  );
  const { ctx, clock } = await fakeWorkerContext("host", {});
  const config = await loadConfig({
    filesystem: new MemoryFilesystem(),
    modules: fakes.map((definition) => ({ ...definition.config, name: definition.name })),
    overrides: {
      capabilities: Object.fromEntries(fakes.map(({ name }) => [name, { enabled: true }])),
    } as never,
    systemStats: new FakeSystemStats({ cpuCount: 4, totalRamBytes: 16 * 1024 ** 3 }),
  });
  const host = await createModuleHost({
    config,
    context: ctx,
    definitions: fakes as never,
    logger: new NoopLogger(),
    role: "worker",
    tokens: fakeModuleTokens(),
  });
  return { clock, host };
}

describe("the module host's findings", () => {
  it("awaits sync and async findings under one deadline and drops a late or throwing module's, and marks an advisory one", async () => {
    const never = new Promise<readonly ModuleFinding[]>(() => undefined);
    const cases: readonly [
      label: string,
      modules: Parameters<typeof hostOf>[0],
      expected: readonly string[],
    ][] = [
      ["one sync", { sync: () => [finding("s")] }, ["sync: s"]],
      [
        "one advisory",
        { warn: () => [{ ...finding("w"), advisory: true as const }] },
        ["warn: w (advisory)"],
      ],
      ["one async", { slow: () => Promise.resolve([finding("a")]) }, ["slow: a"]],
      [
        "one async past the deadline beside a sync one",
        { hung: () => never, sync: () => [finding("s")] },
        ["sync: s"],
      ],
      [
        "one throws",
        {
          boom: () => {
            throw new Error("boom");
          },
          sync: () => [finding("s")],
        },
        ["sync: s"],
      ],
    ];
    for (const [label, modules, expected] of cases) {
      const { clock, host } = await hostOf(modules);
      let found: Awaited<ReturnType<typeof host.findings>> | undefined;
      void host.findings().then((all) => {
        found = all;
      });
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(FINDINGS_DEADLINE_MS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        (found ?? []).map(
          (entry) =>
            `${entry.module}: ${entry.message}${entry.kind === "module-advisory" ? " (advisory)" : ""}`,
        ),
        label,
      ).toEqual(expected);
    }
  });
});
