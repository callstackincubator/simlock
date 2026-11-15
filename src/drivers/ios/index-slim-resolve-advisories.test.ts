import { afterEach, expect, describe, it } from "vitest";
import { MemoryFilesystem, ScriptedProcessRunner, FakeClock } from "../../ports/index.js";
import { deviceRoot, createSlimDriver } from "./test-slim.js";
import {
  IOS_RUNTIME_ASSET_ROOT,
  SizedFilesystem,
  UNSCOPED_LEGACY_CALLS,
  assetInfoPlist,
  createDriver,
  listFixture,
  listInvocation,
  scopedRunners,
  scriptedListRunner,
  slimOptions,
} from "./test-index.js";

/**
 * why: The one global invariant, asserted over everything every test in this file recorded
 * rather than per call site: scoping is what makes ownership provable, so a spawn that
 * reached `xcrun` without `simctl --set <root>` in front of it would address the machine's
 * default device set (safety rule 8). Per-test argv equality proves today's calls are
 * scoped; only this proves the next one added is, whether or not it goes through
 * `#invokeSimctl`.
 */
afterEach(() => {
  for (const call of scopedRunners.splice(0).flatMap((runner) => runner.calls)) {
    // why: Not every spawn addresses a device: `xcodebuild -downloadPlatform` installs a runtime
    // and has no device set to point at. The invariant is about the calls that *do* -- a
    // `simctl` that reached the machine's default set is the leak this guards.
    if (call.command !== "xcrun" || call.args[0] !== "simctl") continue;
    if (UNSCOPED_LEGACY_CALLS.has(call.args.join(" "))) continue;
    expect(call.args.slice(0, 2)).toEqual(["simctl", "--set"]);
    expect([deviceRoot, `${deviceRoot}/sources`]).toContain(call.args[2]);
  }
});

describe("IosSimctlDriver", () => {
  describe("slim mode", () => {
    describe("resolveSpec and the device mode", () => {
      const iphone16 = { model: "iPhone 16", platform: "ios" } as const;

      it("returns a full spec for a slim request on a runtime below 18.5", async () => {
        const driver = await createSlimDriver(
          scriptedListRunner(),
          new MemoryFilesystem(),
          slimOptions(),
        );

        await expect(
          driver.resolveSpec({ ...iphone16, mode: "slim", osVersion: "18.4" }),
        ).resolves.toEqual({ ...iphone16, osVersion: "18.4", physical: false });
      });

      it("gives two requests with different modes for one model and runtime different specs", async () => {
        const list = {
          match: listInvocation,
          result: { code: 0, stderr: "", stdout: listFixture },
        };
        const driver = await createSlimDriver(
          new ScriptedProcessRunner([list, list]),
          new MemoryFilesystem(),
          slimOptions(),
        );

        const slim = await driver.resolveSpec({ ...iphone16, mode: "slim", osVersion: "26.5" });
        const full = await driver.resolveSpec({ ...iphone16, mode: "full", osVersion: "26.5" });

        expect(slim).toEqual({ ...iphone16, mode: "slim", osVersion: "26.5", physical: false });
        expect(full).toEqual({ ...iphone16, osVersion: "26.5", physical: false });
      });

      it("returns a full spec for a slim request when slim is not configured", async () => {
        const driver = await createDriver(scriptedListRunner());

        await expect(
          driver.resolveSpec({ ...iphone16, mode: "slim", osVersion: "26.5" }),
        ).resolves.toEqual({ ...iphone16, osVersion: "26.5", physical: false });
      });
    });

    describe("advisories()", () => {
      it("reports slim-runtime-unsupported when the default mode is slim and an installed runtime predates 18.5", async () => {
        const driver = await createSlimDriver(
          scriptedListRunner(),
          new MemoryFilesystem(),
          slimOptions(),
          undefined,
          undefined,
          true,
        );

        await expect(driver.advisories()).resolves.toEqual([
          {
            code: "slim-runtime-unsupported",
            message: expect.stringContaining("18.4"),
          },
        ]);
      });

      it("reports nothing when every installed runtime is 18.5+", async () => {
        const onlyNewFixture = JSON.stringify({
          devicetypes: (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes,
          runtimes: (
            JSON.parse(listFixture) as { runtimes: { version: string }[] }
          ).runtimes.filter((runtime) => runtime.version !== "18.4"),
        });
        const runner = new ScriptedProcessRunner([
          { match: listInvocation, result: { code: 0, stderr: "", stdout: onlyNewFixture } },
        ]);
        const driver = await createSlimDriver(
          runner,
          new MemoryFilesystem(),
          slimOptions(),
          undefined,
          undefined,
          true,
        );

        await expect(driver.advisories()).resolves.toEqual([]);
      });

      it("reports nothing when slim is not configured", async () => {
        const driver = await createDriver(scriptedListRunner());

        await expect(driver.advisories()).resolves.toEqual([]);
      });

      it("reports an installed runtime with an unparseable identifier as unsupported, even though its marketing version looks modern (finding #5, issue #87 review)", async () => {
        // why: The marketing `version` string here ("26.5") would pass the persistent-slim floor if
        // `advisories()` still parsed it directly -- but this fixture's `identifier` doesn't
        // match `iosRuntimeVersionFromId`'s pattern, and `planSlimBoot` (the boot-time decision)
        // only ever reads the identifier. `advisories()` must reuse that same call so the two
        // can never disagree about whether this runtime actually gets slimmed.
        const devicetypes = (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes;
        const weirdIdentifierFixture = JSON.stringify({
          devicetypes,
          runtimes: [
            {
              identifier: "com.apple.CoreSimulator.SimRuntime.iOS-not-a-version",
              isAvailable: true,
              name: "iOS 26.5",
              supportedDeviceTypes: [],
              version: "26.5",
            },
          ],
        });
        const runner = new ScriptedProcessRunner([
          {
            match: listInvocation,
            result: { code: 0, stderr: "", stdout: weirdIdentifierFixture },
          },
        ]);
        const driver = await createSlimDriver(
          runner,
          new MemoryFilesystem(),
          slimOptions(),
          undefined,
          undefined,
          true,
        );

        await expect(driver.advisories()).resolves.toEqual([
          {
            code: "slim-runtime-unsupported",
            message: expect.stringContaining("26.5"),
          },
        ]);
      });

      it("reports nothing for an iOS 27.2 device-specific runtime installed beside the general one (#1064)", async () => {
        const devicetypes = (JSON.parse(listFixture) as { devicetypes: unknown }).devicetypes;
        const deviceSpecificFixture = JSON.stringify({
          devicetypes,
          runtimes: [
            {
              buildversion: "24B91016s",
              identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4",
              isAvailable: true,
              name: "iOS 27.2",
              supportedDeviceTypes: [],
              version: "27.2",
            },
            {
              buildversion: "24B8117",
              identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2",
              isAvailable: true,
              name: "iOS 27.2",
              supportedDeviceTypes: [],
              version: "27.2",
            },
          ],
        });
        const runner = new ScriptedProcessRunner([
          {
            match: listInvocation,
            result: { code: 0, stderr: "", stdout: deviceSpecificFixture },
          },
        ]);
        const driver = await createSlimDriver(
          runner,
          new MemoryFilesystem(),
          slimOptions(),
          undefined,
          undefined,
          true,
        );

        await expect(driver.advisories()).resolves.toEqual([]);
      });

      it("reports nothing when the default mode is full, even with a runtime below 18.5 installed", async () => {
        const driver = await createSlimDriver(
          scriptedListRunner(),
          new MemoryFilesystem(),
          slimOptions(),
          undefined,
          undefined,
          false,
        );

        await expect(driver.advisories()).resolves.toEqual([]);
      });

      it("reports downloaded runtime assets whose runtime is not in the catalog, and only those (#79)", async () => {
        // why: `simctl runtime delete` only unregisters a runtime from CoreSimulator: its ~8.5 GiB
        // asset bundle stays in mobileassetd's store, tagged `NeverCollected`, on the same
        // volume the download preflight measures. So the bytes stay spent and CoreSimulator can
        // re-register the runtime from them later. The catalog here installs 18.4 and 26.5 while
        // the store still holds two builds nobody deleted the assets for.
        const filesystem = new MemoryFilesystem();
        for (const [bundle, simulatorVersion, build] of [
          ["a1.asset", "18.4", "22E238"],
          ["b2.asset", "26.5", "23F79"],
          ["c3.asset", "18.6", "22G86"],
          ["d4.asset", "26.3", "23D60"],
        ] as const) {
          await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/${bundle}`);
          await filesystem.writeFileAtomic(
            `${IOS_RUNTIME_ASSET_ROOT}/${bundle}/Info.plist`,
            assetInfoPlist(simulatorVersion, build),
          );
        }
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        // why: The advisory code and message shape are a proposal (see the triage report), so this
        // pins only what any fix must do: name both orphan builds, name neither installed one.
        const advisories = await driver.advisories();
        const text = advisories.map((advisory) => advisory.message).join("\n");
        expect(advisories.map((advisory) => advisory.code)).toContain(
          "runtime-cache-unreclaimable",
        );
        expect(text).toContain("18.6");
        expect(text).toContain("26.3");
        expect(text).not.toContain("18.4");
        expect(text).not.toContain("26.5");
      });

      it("tells two downloads of one marketing version apart by build, and reports only the uninstalled one (#79)", async () => {
        // why: simctl reports `buildversion`, and a version match alone would call this bundle
        // installed: 18.4 is in the catalog, but not from this download. Deleting the runtime
        // and re-downloading the same version leaves exactly this -- a stale build nobody can
        // reclaim, sitting behind an installed runtime of the same name.
        const catalog = JSON.parse(listFixture) as {
          devicetypes: unknown;
          runtimes: { version: string }[];
        };
        const withBuilds = JSON.stringify({
          devicetypes: catalog.devicetypes,
          runtimes: catalog.runtimes.map((runtime) => ({
            ...runtime,
            buildversion: runtime.version === "18.4" ? "22E238" : "23F79",
          })),
        });
        const filesystem = new MemoryFilesystem();
        for (const [bundle, build] of [
          ["a1.asset", "22E238"],
          ["stale.asset", "22E247"],
        ] as const) {
          await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/${bundle}`);
          await filesystem.writeFileAtomic(
            `${IOS_RUNTIME_ASSET_ROOT}/${bundle}/Info.plist`,
            assetInfoPlist("18.4", build),
          );
        }
        const runner = new ScriptedProcessRunner([
          { match: listInvocation, result: { code: 0, stderr: "", stdout: withBuilds } },
        ]);
        const driver = await createDriver(runner, new FakeClock(), filesystem);

        const advisories = await driver.advisories();

        expect(advisories).toEqual([
          {
            code: "runtime-cache-unreclaimable",
            message: expect.stringContaining("22E247"),
          },
        ]);
        expect(advisories[0]?.message).not.toContain("22E238");
      });

      it("names orphaned runtimes oldest first, not in string order (#79)", async () => {
        // why: A store that has been collecting for months is read by a human deciding what to
        // reclaim; "iOS 9.3, iOS 18.6" is that list, and a plain string sort inverts it.
        const filesystem = new MemoryFilesystem();
        for (const [bundle, simulatorVersion, build] of [
          ["new.asset", "18.6", "22G86"],
          ["old.asset", "9.3", "13E233"],
        ] as const) {
          await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/${bundle}`);
          await filesystem.writeFileAtomic(
            `${IOS_RUNTIME_ASSET_ROOT}/${bundle}/Info.plist`,
            assetInfoPlist(simulatorVersion, build),
          );
        }
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        const message = (await driver.advisories())[0]?.message ?? "";

        expect(message.indexOf("9.3")).toBeLessThan(message.indexOf("18.6"));
      });

      it("states no size in the advisory when a leftover download's size cannot be read", async () => {
        const bundle = `${IOS_RUNTIME_ASSET_ROOT}/c3.asset`;
        const filesystem = new MemoryFilesystem();
        await filesystem.mkdirp(`${bundle}/AssetData`);
        await filesystem.writeFileAtomic(`${bundle}/Info.plist`, assetInfoPlist("18.6", "22G86"));
        filesystem.defineFailure(`${bundle}/AssetData`, "EACCES");
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        const advisories = await driver.advisories();

        expect(advisories).toEqual([
          {
            code: "runtime-cache-unreclaimable",
            message: expect.stringContaining(
              "iOS 18.6 (22G86) is no longer installed, but its download is still in",
            ),
          },
        ]);
        expect(advisories[0]?.message).not.toContain("GiB");
      });

      it("counts two downloads of one build as downloads of one runtime, with their total size", async () => {
        const filesystem = new SizedFilesystem(
          new Map([
            [`${IOS_RUNTIME_ASSET_ROOT}/c3.asset`, 8_917_036 * 1024],
            [`${IOS_RUNTIME_ASSET_ROOT}/c4.asset`, 8_917_036 * 1024],
          ]),
        );
        for (const bundle of ["c3.asset", "c4.asset"]) {
          await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/${bundle}`);
          await filesystem.writeFileAtomic(
            `${IOS_RUNTIME_ASSET_ROOT}/${bundle}/Info.plist`,
            assetInfoPlist("18.6", "22G86"),
          );
        }
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        const message = (await driver.advisories())[0]?.message ?? "";

        expect(message).toContain(
          "iOS 18.6 (22G86) is no longer installed, but its downloads (17.0 GiB in all) are " +
            "still in",
        );
      });

      it("states the measured sizes of several leftover downloads as one total", async () => {
        // why: The sizes of the iOS 18.6 and 18.4 downloads measured on a real machine; this catalog
        // installs 18.4, so the second bundle is labelled 18.3 to be reported.
        const filesystem = new SizedFilesystem(
          new Map([
            [`${IOS_RUNTIME_ASSET_ROOT}/c3.asset`, 8_917_036 * 1024],
            [`${IOS_RUNTIME_ASSET_ROOT}/e5.asset`, 8_916_744 * 1024],
          ]),
        );
        for (const [bundle, simulatorVersion, build] of [
          ["c3.asset", "18.6", "22G86"],
          ["e5.asset", "18.3", "22D8075"],
        ] as const) {
          await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/${bundle}`);
          await filesystem.writeFileAtomic(
            `${IOS_RUNTIME_ASSET_ROOT}/${bundle}/Info.plist`,
            assetInfoPlist(simulatorVersion, build),
          );
        }
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        const advisories = await driver.advisories();

        expect(advisories).toEqual([
          {
            code: "runtime-cache-unreclaimable",
            message: expect.stringContaining(
              "iOS 18.3 (22D8075), 18.6 (22G86) are no longer installed, but their downloads " +
                "(17.0 GiB in all) are still in",
            ),
          },
        ]);
      });

      it("reports nothing when every downloaded asset belongs to an installed runtime (#79)", async () => {
        const filesystem = new MemoryFilesystem();
        await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/a1.asset`);
        await filesystem.writeFileAtomic(
          `${IOS_RUNTIME_ASSET_ROOT}/a1.asset/Info.plist`,
          assetInfoPlist("18.4", "22E238"),
        );
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        await expect(driver.advisories()).resolves.toEqual([]);
      });

      it("stays quiet, and asks simctl nothing, when the asset store cannot be read (#79)", async () => {
        // why: The store is macOS's, not Simlock's: absent on a machine that never downloaded a
        // runtime, and readable only to whoever the OS says. Neither is a `doctor` failure --
        // and with nothing to report, the `simctl list` that would classify the bundles is
        // never worth running, which is why the runner below scripts no invocation at all.
        const filesystem = new MemoryFilesystem();
        filesystem.defineFailure(IOS_RUNTIME_ASSET_ROOT, "EACCES");
        const runner = new ScriptedProcessRunner([]);
        const driver = await createDriver(runner, new FakeClock(), filesystem);

        await expect(driver.advisories()).resolves.toEqual([]);
        expect(runner.calls).toEqual([]);
      });

      it("skips an asset bundle it cannot identify by build rather than naming it (#79)", async () => {
        // why: The build is what decides whether a bundle's runtime is installed, so a bundle
        // without one cannot be classified -- and guessing would send the operator to delete
        // a runtime they are still using. `missing-build.asset` below names iOS 19.9 and
        // nothing else; the store around it is still reported.
        const filesystem = new MemoryFilesystem();
        await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/missing-build.asset`);
        await filesystem.writeFileAtomic(
          `${IOS_RUNTIME_ASSET_ROOT}/missing-build.asset/Info.plist`,
          assetInfoPlist("19.9", "22H1").replace("<key>Build</key><string>22H1</string>", ""),
        );
        await filesystem.mkdirp(`${IOS_RUNTIME_ASSET_ROOT}/orphan.asset`);
        await filesystem.writeFileAtomic(
          `${IOS_RUNTIME_ASSET_ROOT}/orphan.asset/Info.plist`,
          assetInfoPlist("18.6", "22G86"),
        );
        const driver = await createDriver(scriptedListRunner(), new FakeClock(), filesystem);

        const advisories = await driver.advisories();

        expect(advisories).toEqual([
          {
            code: "runtime-cache-unreclaimable",
            message: expect.stringContaining("18.6"),
          },
        ]);
        expect(advisories[0]?.message).not.toContain("19.9");
      });
    });
  });
});
