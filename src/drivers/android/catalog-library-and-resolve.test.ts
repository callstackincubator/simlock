import { describe, expect, it } from "vitest";

import { ScriptedProcessRunner } from "../../ports/index.js";

import type { DeviceProfileSourceDiagnostic } from "./device-profile-source.js";
import { binaries, androidFilesystem, createPart, fitHarness } from "./test-catalog.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  customDeviceXml,
  type FitImage,
  HOST_IMAGES,
  pixelDevices,
  processResult,
  testLibraryProfile,
  twoPixelDevices,
  writeDevicesXml,
} from "./testing.js";

// why: the verbatim source.properties of the real android-Baklava image installed beside
// android-36 and android-37.0 on a reporting host, so the fixture holds what the SDK really stores.
const BAKLAVA_SOURCE_PROPERTIES =
  "Pkg.Desc=System Image arm64-v8a with Google APIs.\n" +
  "Pkg.Revision=4\n" +
  "AndroidVersion.ApiLevel=35\n" +
  "AndroidVersion.CodeName=Baklava\n" +
  "SystemImage.Abi=arm64-v8a\n" +
  "SystemImage.TagId=google_apis\n";

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Catalog` directly over a memory filesystem and a scripted `avdmanager`.
describe("Catalog", () => {
  describe("library catalog", () => {
    const classes: Record<string, string> = {
      "Automotive (1024p landscape)": "auto",
      "Automotive (1080p landscape)": "auto",
      "Large Desktop": "desktop",
      "Medium Desktop": "desktop",
      "Medium Phone": "phone",
      "Medium Tablet": "tablet",
      "Pixel 6": "phone",
      "Pixel 7": "phone",
      "Pixel 8": "phone",
      "Pixel 9": "phone",
      "Pixel 9 Pro XL": "phone",
      "Small Phone": "phone",
      "Television (1080p)": "tv",
      "Television (4K)": "tv",
      "Wear OS Large Round": "watch",
      "Wear OS Small Round": "watch",
    };

    it("surfaces malformed devices.xml as a diagnostic and falls through to UnknownModelError, never throwing from the parse itself", async () => {
      const filesystem = await androidFilesystem();
      await filesystem.mkdirp(`${home}/.android`);
      await filesystem.writeFileAtomic(`${home}/.android/devices.xml`, "not xml at all {{{");
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], pixelDevices),
      ]);
      const diagnostics: DeviceProfileSourceDiagnostic[] = [];
      const part = createPart(filesystem, runner, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      await expect(
        part.resolveSpec({
          model: "Nonexistent Model",
          osVersion: "34",
          platform: "android",
        }),
      ).rejects.toMatchObject({ name: "UnknownModelError" });

      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: "device-profile-source-unreadable" }),
      ]);
    });

    it("lists Pixel 9 first in the catalog, once, as `phone`, not custom, with `pixel_9` as its other name", async () => {
      const filesystem = await androidFilesystem();
      await writeDevicesXml(
        filesystem,
        customDeviceXml("pixel_9", 4096) + customDeviceXml("PIXEL 9", 4096),
      );
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], twoPixelDevices),
      ]);
      const part = createPart(filesystem, runner);

      const catalog = await part.listCatalog();

      expect(catalog.models[0]).toBe("Pixel 9");
      expect(catalog.models.filter((model) => model.toLocaleLowerCase() === "pixel 9")).toEqual([
        "Pixel 9",
      ]);
      expect(catalog.modelClasses["Pixel 9"]).toBe("phone");
      expect(catalog.customModels ?? []).not.toContain("Pixel 9");
      expect(catalog.modelAliases["Pixel 9"]).toEqual(["pixel_9"]);
    });

    it("every library model resolves, and the catalog lists all 16 with their table classes, when `avdmanager list device` lists none of them", async () => {
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], "Available devices:\n"),
      ]);
      const part = createPart(
        await androidFilesystem({
          images: [
            ["36", "google_apis", "arm64-v8a"],
            ["36", "android-tv", "arm64-v8a"],
            ["36", "android-wear", "arm64-v8a"],
            ["36", "android-automotive", "arm64-v8a"],
            ["36", "android-automotive-playstore", "arm64-v8a"],
            ["36", "android-desktop", "arm64-v8a"],
          ],
        }),
        runner,
      );

      const catalog = await part.listCatalog();
      const resolved: string[] = [];
      for (const model of Object.keys(classes)) {
        resolved.push((await part.resolveSpec({ model, platform: "android" })).model);
      }

      expect(resolved).toEqual(Object.keys(classes));
      expect(Object.keys(classes).filter((model) => !catalog.models.includes(model))).toEqual([]);
      for (const [model, deviceClass] of Object.entries(classes)) {
        expect(catalog.modelClasses[model], model).toBe(deviceClass);
      }
      expect(catalog.modelAliases["Television (4K)"]).toEqual(["tv_4k"]);
    });

    it("the catalog classes Medium Tablet `tablet` when `avdmanager list device` also lists `medium_tablet`", async () => {
      const listing =
        'Available devices:\nid: 0 or "medium_tablet"\n    Name: Medium Tablet\n    OEM : Generic\n';
      const runner = new ScriptedProcessRunner([
        processResult(binaries.avdmanager, ["list", "device"], listing),
      ]);
      const part = createPart(await androidFilesystem(), runner);

      const catalog = await part.listCatalog();

      expect(catalog.modelClasses["Medium Tablet"]).toBe("tablet");
      expect(catalog.models.filter((model) => model === "Medium Tablet")).toHaveLength(1);
    });
  });

  describe("each row of the In short table", () => {
    interface Row {
      readonly name: string;
      readonly images?: readonly FitImage[];
      readonly model: string;
      readonly os?: string;
      readonly tag?: string;
      readonly resolves?: string;
      readonly resolvedTag?: string;
      readonly refusedDownloadable?: boolean;
      readonly refusedComponent?: string;
      readonly pkg?: string;
    }
    const withGoogleTv: readonly FitImage[] = [...HOST_IMAGES, ["36", "google-tv", "arm64-v8a"]];
    const withWear: readonly FitImage[] = [...HOST_IMAGES, ["34", "android-wear", "arm64-v8a"]];
    const rows: readonly Row[] = [
      { model: "Television (1080p)", name: "TV 1080p", resolves: "34" },
      { model: "Television (1080p)", name: "TV 1080p at 36", os: "36", refusedDownloadable: false },
      {
        model: "Television (1080p)",
        name: "TV 1080p with image tag google_apis",
        refusedDownloadable: false,
        tag: "google_apis",
      },
      { model: "Television (720p)", name: "TV 720p, SDK only", resolves: "34" },
      {
        images: withGoogleTv,
        model: "Television (1080p)",
        name: "TV 1080p with a google-tv image at 36",
        resolves: "36",
      },
      { images: withWear, model: "Wear OS Large Round", name: "Wear OS", resolves: "34" },
      { model: "Pixel 9", name: "Pixel 9", resolves: "36" },
      { model: "Pixel 9", name: "Pixel 9 at 34", os: "34", refusedDownloadable: false },
      {
        model: "Pixel 9",
        name: "Pixel 9 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      { model: "Television (1080p)", name: "TV 1080p at 37", os: "37", refusedDownloadable: false },
      { model: "Pixel 6", name: "Pixel 6", resolves: "35" },
      { model: "Pixel 6", name: "Pixel 6 at 36", os: "36", refusedDownloadable: false },
      {
        model: "Pixel 6",
        name: "Pixel 6 at 37",
        os: "37",
        refusedComponent: "37",
        refusedDownloadable: true,
      },
      {
        model: "Pixel 6",
        name: "Pixel 6 with image tag google_apis_playstore",
        refusedDownloadable: false,
        tag: "google_apis_playstore",
      },
      {
        model: "Medium Phone",
        name: "Medium Phone with image tag google_apis_playstore",
        resolvedTag: "google_apis_playstore",
        resolves: "36",
        tag: "google_apis_playstore",
      },
      { model: "Medium Phone", name: "Medium Phone at 35", os: "35", resolves: "35" },
      { model: "Pixel 9 Pro", name: "Pixel 9 Pro, SDK only", resolves: "36" },
      { model: "My Tablet", name: "My Tablet, custom", resolves: "36" },
    ];

    it.each(rows)("$name gives its After result", async (row) => {
      const { part, refusal, resolve } = await fitHarness(row.images ?? HOST_IMAGES);

      if (row.refusedDownloadable !== undefined) {
        expect(await refusal(row.model, row.os, row.tag)).toMatchObject({
          component: row.refusedComponent,
          downloadable: row.refusedDownloadable,
          name: "RuntimeMissingError",
        });
        if (row.os !== undefined) {
          expect((await part.listCatalog()).modelRuntimes[row.model]).not.toContain(row.os);
        }
        return;
      }
      const spec = await resolve(row.model, row.os, row.tag);
      expect(spec).toEqual({
        ...(row.resolvedTag === undefined ? {} : { imageTag: row.resolvedTag }),
        model: row.model,
        osVersion: row.resolves,
        physical: false,
        platform: "android",
      });
      expect((await part.listCatalog()).modelRuntimes[row.model]).toContain(spec.osVersion);
    });

    it("pairs My Tablet with 35 and 36 and not the TV image at 34, and the TV with 34 only", async () => {
      const { part } = await fitHarness(HOST_IMAGES);

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["My Tablet"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Television (1080p)"]).toEqual(["34"]);
      expect(modelRuntimes["Pixel 9"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Pixel 6"]).toEqual(["35"]);
    });
  });

  describe("downloads", () => {
    it("is not downloadable for an uninstalled level above the profile's API range", async () => {
      const old = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });
      expect((await old.refusal("Old Phone", "34")).downloadable).toBe(false);
    });
  });

  describe("the catalog", () => {
    it("lists in modelRuntimes only levels with a fitting image, and every installed image elsewhere", async () => {
      const { part } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["37", "android-xr", "arm64-v8a"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Pixel 5"]).toEqual(["35"]);
      expect(catalog.modelRuntimes["Television (1080p)"]).toEqual([]);
      expect(catalog.runtimes).toEqual(["35", "37"]);
      expect(catalog.defaultRuntime).toBe("37");
      expect(catalog.images).toEqual([
        { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
        { abi: "arm64-v8a", runtime: "37", tag: "android-xr" },
      ]);
    });

    it("resolves every pair it lists, and refuses a level it leaves out", async () => {
      const { part, refusal, resolve } = await fitHarness([
        ...HOST_IMAGES,
        ["36", "android-wear", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
      ]);
      const catalog = await part.listCatalog();
      const pairs = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        levels.map((level) => ({ level, model })),
      );
      const left = Object.entries(catalog.modelRuntimes).flatMap(([model, levels]) =>
        catalog.runtimes
          .filter((level) => !levels.includes(level))
          .map((level) => ({ level, model })),
      );
      expect(pairs.length).toBeGreaterThan(0);
      expect(left.length).toBeGreaterThan(0);

      for (const { level, model } of pairs) {
        expect(await resolve(model, level)).toMatchObject({ model, osVersion: level });
      }
      for (const { level, model } of left) {
        expect(await refusal(model, level)).toMatchObject({
          downloadable: false,
          name: "RuntimeMissingError",
        });
      }
    });

    it("pairs a devices.xml profile avdmanager did not list with every installed phone level", async () => {
      const { part, resolve } = await fitHarness(HOST_IMAGES, {
        devicesXml: customDeviceXml("Legacy Phone", 2048),
      });

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Legacy Phone"]).toEqual(["35", "36"]);
      expect(await resolve("Legacy Phone", "35")).toMatchObject({ osVersion: "35" });
    });

    it("counts android-Baklava with AndroidVersion.ApiLevel=35 as a level Pixel 9 pairs with", async () => {
      const { part, resolve } = await fitHarness([
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=35\n"],
        ["34", "google_apis", "arm64-v8a"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Pixel 9"]).toEqual(["Baklava"]);
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "Baklava" });
    });

    it("ranks a preview image by the API level it records, so a newer numeric level stays the newest", async () => {
      const { part, resolve } = await fitHarness([
        ["35", "google_apis", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
      ]);

      const catalog = await part.listCatalog();

      // why: stated first so the assertions below can only fail on the *ranking* — the preview is
      // genuinely a listed candidate, not something the catalog left out.
      expect(catalog.runtimes).toContain("Baklava");
      expect(catalog.modelRuntimes["Pixel 9"]).toContain("Baklava");
      expect(catalog.defaultRuntime).toBe("37.0");
      expect(await resolve("Pixel 9")).toMatchObject({ osVersion: "37.0" });
    });

    it("ranks a preview image above the numeric levels when the level it records is higher", async () => {
      const { part } = await fitHarness([
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", "AndroidVersion.ApiLevel=38\n"],
      ]);

      expect((await part.listCatalog()).defaultRuntime).toBe("Baklava");
    });

    it("ranks a preview folder by the highest level any of its images records, so an image recording none does not raise it", async () => {
      const { part } = await fitHarness([
        ["36", "google_apis", "arm64-v8a"],
        ["37.0", "google_apis", "arm64-v8a"],
        ["Baklava", "google_apis", "arm64-v8a", BAKLAVA_SOURCE_PROPERTIES],
        ["Baklava", "google_apis_playstore", "arm64-v8a"],
      ]);

      expect((await part.listCatalog()).defaultRuntime).toBe("37.0");
    });

    it.each([
      ["lower first", "35", "38"],
      ["higher first", "38", "35"],
    ])(
      "ranks a preview folder by the highest level among its images, whichever is read first (%s)",
      async (_order, first, second) => {
        const { part } = await fitHarness([
          ["37.0", "google_apis", "arm64-v8a"],
          ["Baklava", "google_apis", "arm64-v8a", `AndroidVersion.ApiLevel=${first}\n`],
          ["Baklava", "google_apis_playstore", "arm64-v8a", `AndroidVersion.ApiLevel=${second}\n`],
        ]);

        expect((await part.listCatalog()).defaultRuntime).toBe("Baklava");
      },
    );

    it("uses the folder name for --image-tag and the catalog's images[].tag when SystemImage.TagId differs", async () => {
      const { part, refusal, resolve } = await fitHarness([
        ["35", "custom-folder", "arm64-v8a", "SystemImage.TagId=google_apis_playstore\n"],
      ]);

      const catalog = await part.listCatalog();

      expect(catalog.images).toEqual([{ abi: "arm64-v8a", runtime: "35", tag: "custom-folder" }]);
      expect(await resolve("Pixel 5", undefined, "custom-folder")).toMatchObject({
        imageTag: "custom-folder",
      });
      expect(await refusal("Pixel 5", undefined, "google_apis_playstore")).toMatchObject({
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });
  });

  describe("resolveSpec", () => {
    it("gives a request with no version the newest level with a fitting image", async () => {
      const { resolve } = await fitHarness([
        ["34", "android-tv", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
        ["36", "google_apis", "arm64-v8a"],
      ]);

      expect(await resolve("Television (1080p)")).toMatchObject({ osVersion: "35" });
    });

    it("fails a request with no version RUNTIME_MISSING, not downloadable, when no level has a fitting image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect(await refusal("Television (1080p)")).toMatchObject({
        component: undefined,
        downloadable: false,
        name: "RuntimeMissingError",
      });
    });

    it("skips a newest level whose image of the tag misfits and takes the newest level where it fits", async () => {
      const { resolve } = await fitHarness(
        [
          ["34", "google_apis_playstore", "arm64-v8a"],
          ["36", "google_apis_playstore", "arm64-v8a"],
        ],
        {
          profiles: [
            testLibraryProfile({
              apiRange: { max: 35, min: 24 },
              name: "Capped",
              names: ["Capped"],
            }),
          ],
        },
      );

      expect(await resolve("Capped", undefined, "google_apis_playstore")).toMatchObject({
        osVersion: "34",
      });
    });
  });
});
