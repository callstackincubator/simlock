import { it, expect, vi, describe } from "vitest";
import { BootTimeoutError } from "../../core/index.js";
import { FakeClock, MemoryFilesystem, ScriptedProcessRunner } from "../../ports/index.js";
import { promiseState } from "../../test-support/promise-state.js";
import {
  iosRuntimeVersionFromId,
  supportsPersistentSlim,
  type SlimSkippedFact,
  IosSimctlDriver,
} from "./index.js";
import { memorySourceDatabase } from "./testing.js";
import {
  driverData,
  FaultyFilesystem,
  plantManagedDevice,
  createSlimDriver,
  prepareSlim,
  parseOverrides,
  overridesPath,
  simctlArgs,
  prepareSlimWith,
  overridesFolder,
  slimBootCalls,
  simctl,
  deviceRoot,
  instanceId,
  overridesRoot,
  waitForCalls,
  flushMicrotasks221,
  settledValue,
  overridesPlist,
  printDisabled,
} from "./test-slim.js";
import {
  neverDisabled,
  prepareFull,
  slimOptions,
  spec,
  wantedOverrides,
  wantedReadback,
  widgetsLabelList,
} from "./test-index.js";

describe("IosSimctlDriver", () => {
  describe("slim mode", () => {
    const widgetsLabels = widgetsLabelList();

    const widgetsSignature = "v1:0dd8c925463fb678";

    const slim18_5 = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-5" };

    const managedCount = Object.keys(wantedOverrides()).length;

    const trueLabel = widgetsLabels[0] ?? "";

    const falseLabel = "com.apple.siriactionsd";

    // why: the label written first is not the first in sorted order, so naming the sorted first
    // differs from naming the first one the readback check meets.
    const firstWritten = Object.keys(wantedOverrides())[0] ?? "";

    const firstSorted = Object.keys(wantedOverrides()).sort()[0] ?? "";

    function flipped(labels: readonly string[]): Record<string, string> {
      return Object.fromEntries(
        labels.map((label) => [label, wantedOverrides()[label] === true ? "enabled" : "disabled"]),
      );
    }

    it("parses simctl runtime ids into [major, minor], including edge cases", () => {
      expect(iosRuntimeVersionFromId("com.apple.CoreSimulator.SimRuntime.iOS-18-5")).toEqual([
        18, 5,
      ]);
      expect(iosRuntimeVersionFromId("com.apple.CoreSimulator.SimRuntime.iOS-26-0")).toEqual([
        26, 0,
      ]);
      expect(iosRuntimeVersionFromId("com.apple.CoreSimulator.SimRuntime.iOS-18")).toEqual([18, 0]);
      expect(iosRuntimeVersionFromId("com.apple.CoreSimulator.SimRuntime.iOS-18-5-1")).toEqual([
        18, 5,
      ]);
      expect(iosRuntimeVersionFromId("")).toBeUndefined();
      expect(iosRuntimeVersionFromId("garbage")).toBeUndefined();
    });

    it("parses a device-specific runtime id (iOS-27-2-iPhone19-4) to the version it names (#1064)", () => {
      // why: Xcode 27.2 installs `com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4` next to
      // `...iOS-27-2`; the suffix after the version names a device family, not a version part.
      expect(
        iosRuntimeVersionFromId("com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4"),
      ).toEqual([27, 2]);
    });

    it("gates persistent slim on iOS 18.5+ without falling into string comparison", () => {
      // why: A naive string/lexicographic compare would put "9.0" ahead of "18.5" -- the gate must
      // compare the parsed integers instead.
      expect(supportsPersistentSlim([18, 5])).toBe(true);
      expect(supportsPersistentSlim([26, 0])).toBe(true);
      expect(supportsPersistentSlim([9, 0])).toBe(false);
      expect(supportsPersistentSlim([18, 4])).toBe(false);
      expect(supportsPersistentSlim(undefined)).toBe(false);
    });

    it.each([
      { name: "no file yet", existing: undefined, expected: wantedOverrides(), rewritten: true },
      {
        name: "an unknown category beside a known one, which is reported",
        existing: undefined,
        expected: wantedOverrides(),
        rewritten: true,
        configured: ["widgets", "nonsense"],
        unknown: ["nonsense"],
      },
      {
        name: "a file with the runtime's own entries, which are kept",
        existing: { "com.apple.runtime.own": true, "com.example.other": false },
        expected: {
          ...wantedOverrides(),
          "com.apple.runtime.own": true,
          "com.example.other": false,
        },
        rewritten: true,
      },
      {
        name: "a file already as wanted, which is not rewritten",
        existing: wantedOverrides(),
        expected: wantedOverrides(),
        rewritten: false,
      },
      {
        name: "a file slimmed under wider categories, whose dropped labels are now off the list",
        existing: Object.fromEntries(
          Object.entries(wantedOverrides()).map(([label]) => [
            label,
            !neverDisabled.includes(label),
          ]),
        ),
        expected: wantedOverrides(),
        rewritten: true,
      },
    ])(
      "writes the launchd overrides before the one boot and grants slim after the readback: $name",
      async ({ existing, expected, rewritten, configured, unknown }) => {
        const filesystem = new FaultyFilesystem();
        await plantManagedDevice(filesystem);
        await plantOverrides(filesystem, existing);
        const clock = new FakeClock();
        const { runner, fileAtBoot } = runnerReadingFileAtBoot(filesystem, clock);
        const onSlimmed = vi.fn();
        const onSlimSkipped = vi.fn();
        const driver = await createSlimDriver(
          runner,
          filesystem,
          { bootTimeoutMs: 300_000, categories: configured ?? ["widgets"] },
          onSlimmed,
          onSlimSkipped,
          false,
          clock,
        );

        const result = await driver.makeReady(
          { address: slim18_5.udid, deviceId: slim18_5.udid, driverData: slim18_5 },
          prepareSlim,
        );

        expect(result).toEqual({
          address: slim18_5.udid,
          deviceId: slim18_5.udid,
          driverData: slim18_5,
          mode: "slim",
        });
        expect(parseOverrides(fileAtBoot() ?? "")).toEqual(expected);
        expect(filesystem.writes).toEqual(rewritten ? [overridesPath(slim18_5.udid)] : []);
        expect(filesystem.modes).toEqual(rewritten ? { file: 0o644, folder: 0o700 } : {});
        expect(runner.calls.map((call) => call.args)).toEqual([
          simctlArgs("rename", slim18_5.udid, driverData.name),
          simctlArgs("boot", slim18_5.udid),
          simctlArgs("bootstatus", slim18_5.udid, "-b"),
          simctlArgs("listapps", slim18_5.udid),
          simctlArgs("spawn", slim18_5.udid, "launchctl", "print-disabled", "system"),
        ]);
        expect(runner.calls[2]?.options).toEqual({ timeoutMs: 260_000 });
        expect(runner.calls[4]?.options).toEqual({ timeoutMs: 120_000 });
        expect(onSlimmed).toHaveBeenCalledTimes(1);
        expect(onSlimmed).toHaveBeenCalledWith({
          address: slim18_5.udid,
          categories: ["widgets"],
          deviceId: slim18_5.udid,
          durationMs: 40_000,
          labelCount: widgetsLabels.length,
          signature: widgetsSignature,
          unknownLabels: unknown ?? [],
        });
        expect(onSlimSkipped).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: "a true label reads enabled",
        readback: () => readbackWith({ [trueLabel]: "enabled" }),
        mode: "full",
        detail: `1 of ${managedCount} managed labels did not read back as written at boot; first: ${trueLabel}`,
      },
      {
        name: "a true label is missing",
        readback: () => readbackWith({ [trueLabel]: undefined }),
        mode: "full",
        detail: `1 of ${managedCount} managed labels did not read back as written at boot; first: ${trueLabel}`,
      },
      {
        name: "a false label reads disabled",
        readback: () => readbackWith({ [falseLabel]: "disabled" }),
        mode: "full",
        detail: `1 of ${managedCount} managed labels did not read back as written at boot; first: ${falseLabel}`,
      },
      {
        name: "two labels disagree, the first by sort order is named",
        readback: () => readbackWith(flipped([firstWritten, firstSorted])),
        mode: "full",
        detail: `2 of ${managedCount} managed labels did not read back as written at boot; first: ${firstSorted}`,
      },
      {
        name: "a true label reads true (older launchd)",
        readback: () => readbackWith({ [trueLabel]: "true" }),
        mode: "slim",
        detail: undefined,
      },
      {
        name: "a false label is missing",
        readback: () => readbackWith({ [falseLabel]: undefined }),
        mode: "slim",
        detail: undefined,
      },
      {
        name: "the readback exits non-zero",
        readback: () => ({ code: 1, stderr: "launchctl: boom\n" }),
        mode: "slim",
        detail: "could not read back the launchd overrides: exit 1: launchctl: boom",
      },
      {
        name: "the readback times out",
        readback: () => "hangs" as const,
        mode: "slim",
        detail: "could not read back the launchd overrides: timed out after 120000ms",
      },
    ])(
      "grants the mode the readback shows and tells why when it disagrees or fails: $name",
      async ({ readback, mode, detail }) => {
        const filesystem = new FaultyFilesystem();
        await plantManagedDevice(filesystem);
        const script = readback();

        const { onSlimSkipped, onSlimmed, result } = await prepareSlimWith(
          filesystem,
          typeof script === "string" && script !== "hangs" ? { stdout: script } : script,
          slimOptions(),
        );

        expect(result.mode).toBe(mode);
        if (detail === undefined) {
          expect(onSlimmed).toHaveBeenCalledTimes(1);
          expect(onSlimSkipped).not.toHaveBeenCalled();
        } else {
          expect(onSlimmed).not.toHaveBeenCalled();
          expect(onSlimSkipped.mock.calls).toEqual([
            [{ deviceId: slim18_5.udid, detail, reason: "apply-failed" }],
          ]);
        }
      },
    );

    it.each([
      {
        name: "writeFileAtomic throws and the readback is as wanted",
        failing: "writeFileAtomic" as const,
        existing: undefined,
        readback: { stdout: readbackWith({}) },
        mode: "slim",
        detail: "could not write the launchd overrides file: disk full",
      },
      {
        name: "mkdirp throws and the readback disagrees",
        failing: "mkdirp" as const,
        existing: undefined,
        readback: { stdout: readbackWith({ [trueLabel]: "enabled" }) },
        mode: "full",
        detail: `could not write the launchd overrides file: disk full; 1 of ${managedCount} managed labels did not read back as written at boot; first: ${trueLabel}`,
      },
      {
        name: "the write throws and the readback fails",
        failing: "writeFileAtomic" as const,
        existing: undefined,
        readback: { code: 1, stderr: "boom" },
        mode: "slim",
        detail:
          "could not write the launchd overrides file: disk full; could not read back the launchd overrides: exit 1: boom",
      },
      {
        name: "the existing file is not a plist dict, is left unchanged, and the readback decides",
        failing: undefined,
        existing: "not a plist",
        readback: { stdout: readbackWith({}) },
        mode: "slim",
        detail:
          "could not write the launchd overrides file: the existing file is not a property list dictionary",
      },
    ])(
      "boots anyway when the overrides file cannot be written and says so: $name",
      async ({ failing, existing, readback, mode, detail }) => {
        const filesystem = new FaultyFilesystem();
        await plantManagedDevice(filesystem);
        if (existing !== undefined) {
          await filesystem.mkdirp(overridesFolder(slim18_5.udid));
          await filesystem.writeFileAtomic(overridesPath(slim18_5.udid), existing);
        }
        filesystem.failing = failing;

        const { onSlimSkipped, onSlimmed, result, runner } = await prepareSlimWith(
          filesystem,
          readback,
          slimOptions(),
        );

        expect(result.mode).toBe(mode);
        expect(runner.calls.map((call) => call.args[3])).toEqual([
          "rename",
          "boot",
          "bootstatus",
          "listapps",
          "spawn",
        ]);
        expect(onSlimmed).not.toHaveBeenCalled();
        expect(onSlimSkipped.mock.calls).toEqual([
          [{ deviceId: slim18_5.udid, detail, reason: "apply-failed" }],
        ]);
        if (existing !== undefined) {
          expect(await filesystem.readFile(overridesPath(slim18_5.udid))).toBe(existing);
        }
      },
    );

    it("ignores a full flag an older daemon stamped into driver data: the spec mode decides", async () => {
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      const stamped = { ...slim18_5, full: true };
      const runner = new ScriptedProcessRunner(slimBootCalls(stamped.udid, wantedReadback()));
      const driver = await createSlimDriver(runner, filesystem, slimOptions());

      const result = await driver.makeReady(
        { address: stamped.udid, deviceId: stamped.udid, driverData: stamped },
        prepareSlim,
      );

      expect(result.mode).toBe("slim");
    });

    it.each([
      {
        name: "full mode",
        runtimeId: slim18_5.runtimeId,
        options: { mode: "full", purpose: "prepare" } as const,
        categories: ["widgets"],
        skipped: undefined,
      },
      {
        name: "a purpose: 'recover' boot, which only reboots",
        runtimeId: slim18_5.runtimeId,
        options: { mode: "slim", purpose: "recover" } as const,
        categories: ["widgets"],
        skipped: undefined,
      },
      {
        name: "runtime 18.4",
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
        options: prepareSlim,
        categories: ["widgets"],
        skipped: "runtime-too-old",
      },
      {
        name: "a runtime id that does not parse",
        runtimeId: "not-a-runtime-id",
        options: prepareSlim,
        categories: ["widgets"],
        skipped: "unknown-runtime",
      },
      {
        name: "configured categories none of which is known",
        runtimeId: slim18_5.runtimeId,
        options: prepareSlim,
        categories: ["nonsense"],
        skipped: "apply-failed",
      },
    ])(
      "touches no overrides file and runs no readback for a device that must not be slimmed: $name",
      async ({ runtimeId, options, categories, skipped }) => {
        const filesystem = new FaultyFilesystem();
        await plantManagedDevice(filesystem);
        filesystem.writes.length = 0;
        const data = { ...driverData, runtimeId };
        const renamed = options.purpose === "prepare";
        const runner = new ScriptedProcessRunner([
          ...(renamed ? [{ match: simctl("rename", data.udid, driverData.name) }] : []),
          { match: simctl("boot", data.udid) },
          { match: simctl("bootstatus", data.udid, "-b") },
          { match: simctl("listapps", data.udid) },
        ]);
        const onSlimmed = vi.fn();
        const onSlimSkipped = vi.fn();
        const driver = await createSlimDriver(
          runner,
          filesystem,
          { bootTimeoutMs: 300_000, categories },
          onSlimmed,
          onSlimSkipped,
        );

        const result = await driver.makeReady(
          { address: data.udid, deviceId: data.udid, driverData: data },
          options,
        );

        expect(result).toEqual({
          address: data.udid,
          deviceId: data.udid,
          driverData: data,
          mode: "full",
        });
        expect(runner.calls.map((call) => call.args)).toEqual([
          ...(renamed ? [simctlArgs("rename", data.udid, driverData.name)] : []),
          simctlArgs("boot", data.udid),
          simctlArgs("bootstatus", data.udid, "-b"),
          simctlArgs("listapps", data.udid),
        ]);
        expect(filesystem.writes).toEqual([]);
        expect(await filesystem.exists(overridesFolder(data.udid))).toBe(false);
        expect(onSlimmed).not.toHaveBeenCalled();
        expect(onSlimSkipped.mock.calls.map(([fact]) => (fact as SlimSkippedFact).reason)).toEqual(
          skipped === undefined ? [] : [skipped],
        );
      },
    );

    it("times out the slim boot's bootstatus using slim.bootTimeoutMs, not the default 120s", async () => {
      const filesystem = new MemoryFilesystem();
      await plantManagedDevice(filesystem);
      const clock = new FakeClock();
      const runner = new ScriptedProcessRunner([
        { match: { command: "xcrun", args: simctlArgs("rename", slim18_5.udid, driverData.name) } },
        { match: { command: "xcrun", args: simctlArgs("boot", slim18_5.udid) } },
        {
          hangs: true,
          match: { command: "xcrun", args: simctlArgs("bootstatus", slim18_5.udid, "-b") },
        },
        { match: { command: "xcrun", args: simctlArgs("shutdown", slim18_5.udid) } },
      ]);
      const driver = await IosSimctlDriver.create({
        database: await memorySourceDatabase(),
        driverConfig: { deviceRoot },
        instanceId,
        simlockHome: "/home/.simlock",
        clock,
        filesystem,
        idGenerator: { generate: () => "device-1" },
        launchdOverridesRoot: overridesRoot,
        processRunner: runner,
        config: { slim: slimOptions() },
      });

      const ready = driver.makeReady(
        { address: slim18_5.udid, deviceId: slim18_5.udid, driverData: slim18_5 },
        prepareSlim,
      );

      await waitForCalls(runner, 3);
      const readyState = promiseState(ready);

      // why: Just past the default 120s: a boot timed against it would have given up by now.
      clock.advance(120_001);
      await flushMicrotasks221();
      expect(readyState.state).toBe("pending");

      clock.advance(300_000 - 120_001);
      expect(await settledValue(ready)).toBeInstanceOf(BootTimeoutError);
      expect(runner.calls[2]?.options).toEqual({ timeoutMs: 300_000 });
    });

    it("an operator's full iOS boot waits ios.full.bootTimeoutMs, then fails with BootTimeoutError", async () => {
      const slim18_4 = { ...driverData, runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" };
      const cases = [
        { data: driverData, full: undefined, options: prepareFull, waitsMs: 300_000 },
        { data: driverData, full: 400_000, options: prepareFull, waitsMs: 400_000 },
        { data: slim18_4, full: 400_000, options: prepareSlim, waitsMs: 400_000 },
        { data: driverData, full: 400_000, options: recoverFull, waitsMs: 400_000 },
        { data: driverData, full: 400_000, options: recoverSlim, waitsMs: 400_000 },
        { data: slim18_5, full: 400_000, options: prepareSlim, waitsMs: 250_000 },
      ];
      for (const { data, full, options, waitsMs } of cases) {
        const filesystem = new MemoryFilesystem();
        await plantManagedDevice(filesystem);
        const clock = new FakeClock();
        const renamed = options.purpose === "prepare";
        const runner = new ScriptedProcessRunner([
          ...(renamed
            ? [
                {
                  match: {
                    command: "xcrun",
                    args: simctlArgs("rename", data.udid, driverData.name),
                  },
                },
              ]
            : []),
          { match: { command: "xcrun", args: simctlArgs("boot", data.udid) } },
          {
            hangs: true,
            match: { command: "xcrun", args: simctlArgs("bootstatus", data.udid, "-b") },
          },
          { match: { command: "xcrun", args: simctlArgs("shutdown", data.udid) } },
        ]);
        const driver = await IosSimctlDriver.create({
          database: await memorySourceDatabase(),
          driverConfig: { deviceRoot },
          instanceId,
          simlockHome: "/home/.simlock",
          clock,
          filesystem,
          idGenerator: { generate: () => "device-1" },
          launchdOverridesRoot: overridesRoot,
          processRunner: runner,
          config: {
            slim: slimOptions(250_000),
            ...(full === undefined ? {} : { full: { bootTimeoutMs: full } }),
          },
        });

        const ready = driver.makeReady(
          { address: data.udid, deviceId: data.udid, driverData: data },
          options,
        );
        await waitForCalls(runner, renamed ? 3 : 2);
        const readyState = promiseState(ready);

        clock.advance(waitsMs - 1);
        await flushMicrotasks221();
        expect(readyState.state, `${JSON.stringify({ full, options })} still waiting`).toBe(
          "pending",
        );

        clock.advance(1);
        expect(await settledValue(ready)).toBeInstanceOf(BootTimeoutError);
      }
    });

    it.each([
      { name: "slim spec", spec: { ...spec, mode: "slim" } as const },
      { name: "full spec", spec },
    ])(
      "quotes the cold-boot cost for a boot of a $name, since a slim boot is one boot",
      async (c) => {
        const driver = await createSlimDriver(
          new ScriptedProcessRunner([]),
          new MemoryFilesystem(),
          slimOptions(),
        );

        expect(driver.estimate({ operation: "boot" }, c.spec)).toBe(60_000);
      },
    );
  });
});

/** why: the state a case starts from, with the writes and modes the planting made forgotten. */
async function plantOverrides(
  filesystem: FaultyFilesystem,
  existing: Readonly<Record<string, boolean>> | undefined,
): Promise<void> {
  if (existing !== undefined) {
    await filesystem.mkdirp(overridesFolder(driverData.udid));
    await filesystem.writeFileAtomic(overridesPath(driverData.udid), overridesPlist(existing));
  }
  filesystem.writes.length = 0;
  delete filesystem.modes.file;
  delete filesystem.modes.folder;
}

/** why: the boot is where launchd reads the file, so the file is captured as the boot starts. */
function runnerReadingFileAtBoot(filesystem: FaultyFilesystem, clock: FakeClock) {
  let contents: string | undefined;
  const calls = slimBootCalls(driverData.udid, wantedReadback());
  const runner = new ScriptedProcessRunner([
    calls[0]!,
    {
      ...calls[1]!,
      onSpawn: async () => {
        clock.advance(40_000);
        const path = overridesPath(driverData.udid);
        contents = (await filesystem.exists(path)) ? await filesystem.readFile(path) : undefined;
      },
    },
    ...calls.slice(2),
  ]);
  return { fileAtBoot: () => contents, runner };
}

/** why: The readback of a boot that honoured every label, with the given labels changed or dropped (`undefined`). */
function readbackWith(changes: Readonly<Record<string, string | undefined>>): string {
  const entries: Record<string, string> = Object.fromEntries(
    Object.entries(wantedOverrides()).map(([label, off]) => [label, off ? "disabled" : "enabled"]),
  );
  for (const [label, state] of Object.entries(changes)) {
    if (state === undefined) delete entries[label];
    else entries[label] = state;
  }
  return printDisabled(entries);
}

const recoverFull = { mode: "full", purpose: "recover" } as const;

const recoverSlim = { mode: "slim", purpose: "recover" } as const;
