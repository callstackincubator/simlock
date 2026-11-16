import { describe, expect, it } from "vitest";

import { binaries, fitHarness } from "./test-catalog.js";
import {
  ANDROID_HOME_DIRECTORY as home,
  customFitXml,
  type FitImage,
  HOST_IMAGES,
  testLibraryProfile,
  userListing,
} from "./testing.js";

// why: a part of a decomposed module (ADR 0063) is tested through its own surface: these build
// `Catalog` directly over a memory filesystem and a scripted `avdmanager`.
describe("Catalog", () => {
  describe("refusal messages", () => {
    const phones: readonly FitImage[] = [
      ["35", "google_apis", "arm64-v8a"],
      ["36", "google_apis_playstore", "arm64-v8a"],
    ];

    it("names the API range for an API level below the profile's minimum", async () => {
      const { refusal } = await fitHarness([["34", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("names the API range for a level above the profile's maximum", async () => {
      const { refusal } = await fitHarness([["35", "google_apis", "arm64-v8a"]], {
        profiles: [
          testLibraryProfile({
            apiRange: { max: 33, min: 24 },
            name: "Old Phone",
            names: ["Old Phone"],
          }),
        ],
      });

      expect((await refusal("Old Phone", "35")).message).toBe(
        "No installed system image fits Old Phone at Android 35: it needs Android 33 or older",
      );
    });

    it.each([
      ["Television (1080p)", "it needs a TV image"],
      ["Wear OS Large Round", "it needs a Wear OS image"],
      ["Automotive (1080p landscape)", "it needs an automotive image"],
      ["Medium Desktop", "it needs a desktop image"],
      ["XR Headset", "it needs an XR image"],
      ["AI Glasses", "it needs an AI glasses image"],
    ])("names the kind for %s with only phone images", async (model, reason) => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal(model, "35")).message).toBe(
        `No installed system image fits ${model} at Android 35: ${reason}`,
      );
    });

    it("names phone or tablet for a profile with no kind whose only image is a TV image", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 5", "34")).message).toBe(
        "No installed system image fits Pixel 5 at Android 34: it needs a phone or tablet image",
      );
    });

    it("names the tag for any other kind", async () => {
      const { refusal } = await fitHarness(phones);

      expect((await refusal("Odd Device", "35")).message).toBe(
        "No installed system image fits Odd Device at Android 35: it needs an image tagged foo-device",
      );
    });

    it.each([
      ["Pixel 6", "36", "google_apis_playstore", "Play Store"],
      ["Pixel 5", "35", "tablet", "tablet"],
    ])(
      "says the model does not take the kind of image it was given (%s)",
      async (model, osVersion, imageTag, noun) => {
        const { refusal } = await fitHarness([[osVersion, imageTag, "arm64-v8a"]]);

        expect((await refusal(model, osVersion)).message).toBe(
          `No installed system image fits ${model} at Android ${osVersion}: ${model} does not take ${noun} images`,
        );
      },
    );

    it("says none of the installed images fit it when no single check rules out every image", async () => {
      const { refusal } = await fitHarness([
        ["35", "google_apis_playstore", "arm64-v8a"],
        ["35", "android-tv", "arm64-v8a"],
      ]);

      expect((await refusal("Pixel 6", "35")).message).toBe(
        "No installed system image fits Pixel 6 at Android 35: none of the installed images fit it",
      );
    });

    it("gives the API range reason for an image that fails both API range and kind", async () => {
      const { refusal } = await fitHarness([["34", "android-tv", "arm64-v8a"]]);

      expect((await refusal("Pixel 9", "34")).message).toBe(
        "No installed system image fits Pixel 9 at Android 34: it needs Android 35 or newer",
      );
    });

    it("drops the level from the message when no version was asked, reading every installed image", async () => {
      const { refusal } = await fitHarness([["36", "google_apis", "arm64-v8a"]]);

      expect((await refusal("Television (1080p)")).message).toBe(
        "No installed system image fits Television (1080p): it needs a TV image",
      );
    });

    it("says an image tag's image does not fit it, and why", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Television (1080p)", undefined, "google_apis")).message).toBe(
        "No installed system image fits Television (1080p): the google_apis image does not fit it: it needs a TV image",
      );
      expect((await refusal("Television (1080p)", "35", "google_apis")).message).toBe(
        "No installed system image fits Television (1080p) at Android 35: the google_apis image does not fit it: it needs a TV image",
      );
    });

    it("says the level is not installed for a level with nothing installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 9", "37")).message).toBe(
        "No installed system image fits Pixel 9 at Android 37: Android 37 is not installed",
      );
    });

    it("says no system image is installed on a host with no image at all", async () => {
      const { refusal } = await fitHarness([]);

      expect((await refusal("Pixel 9")).message).toBe(
        "No installed system image fits Pixel 9: no system image is installed",
      );
    });

    it("keeps today's message for an image tag with no image of that tag installed", async () => {
      const { refusal } = await fitHarness(HOST_IMAGES);

      expect((await refusal("Pixel 5", "35", "default")).message).toBe(
        "No default system image is installed for Android API 35",
      );
    });
  });

  describe("an image tag whose image misfits", () => {
    it("fails RUNTIME_MISSING, not downloadable, and starts no sdkmanager", async () => {
      const { refusal, runner } = await fitHarness(HOST_IMAGES);

      const failure = await refusal("Pixel 6", undefined, "google_apis_playstore");

      expect(failure).toMatchObject({ downloadable: false, name: "RuntimeMissingError" });
      expect(failure.message).toContain("the google_apis_playstore image does not fit it");
      expect(runner.calls.map((call) => call.command)).not.toContain(binaries.sdkmanager);
    });
  });

  describe("custom profile fit from devices.xml", () => {
    const wearImage: FitImage = [
      "34",
      "android-wear",
      "arm64-v8a",
      "SystemImage.TagId=android-wear,google_apis_playstore\n",
    ];

    it("a custom profile listed by avdmanager gets the API range of its devices.xml entry: api-level 31- drops levels below 31 from its modelRuntimes", async () => {
      const images: readonly FitImage[] = [
        ["30", "google_apis", "arm64-v8a"],
        ["31", "google_apis", "arm64-v8a"],
        ["30", "android-tv", "arm64-v8a"],
        ["31", "android-tv", "arm64-v8a"],
      ];
      const open = await fitHarness(images, {
        devicesXml: customFitXml({ name: "Open Phone" }),
        listing: userListing(["Open Phone"]),
      });
      expect((await open.part.listCatalog()).modelRuntimes["Open Phone"]).toEqual(["30", "31"]);
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ apiLevel: "31-", name: "My Phone" }) +
          customFitXml({ apiLevel: "31-", name: "My TV", tagId: "android-tv" }),
        listing: userListing(["My Phone"], ["My TV", "android-tv"]),
      });

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["My Phone"]).toEqual(["31"]);
      expect(modelRuntimes["My TV"]).toEqual(["31"]);
    });

    it("a custom profile with playstore-enabled false drops Play Store images", async () => {
      const images: readonly FitImage[] = [
        ["34", "google_apis_playstore", "arm64-v8a"],
        ["35", "google_apis", "arm64-v8a"],
      ];
      const allowed = await fitHarness(images, {
        devicesXml: customFitXml({ name: "My Phone", playStore: "true" }),
        listing: userListing(["My Phone"]),
      });
      expect((await allowed.part.listCatalog()).modelRuntimes["My Phone"]).toEqual(["34", "35"]);
      const { part } = await fitHarness(images, {
        devicesXml: customFitXml({ name: "My Phone", playStore: "false" }),
        listing: userListing(["My Phone"]),
      });

      expect((await part.listCatalog()).modelRuntimes["My Phone"]).toEqual(["35"]);
    });

    it("a custom Wear profile with playstore-enabled false keeps an image tagged android-wear,google_apis_playstore, listed by avdmanager or devices.xml-only", async () => {
      const wear = customFitXml({ name: "My Watch", playStore: "false", tagId: "android-wear" });
      const listed = await fitHarness([wearImage], {
        devicesXml: wear,
        listing: userListing(["My Watch", "android-wear"]),
      });
      const only = await fitHarness([wearImage], { devicesXml: wear, listing: userListing() });

      expect((await listed.part.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
      expect((await only.part.listCatalog()).modelRuntimes["My Watch"]).toEqual(["34"]);
    });

    it("a custom profile with no type and a 10.1-inch screen that does not fold fits tablet images; a 6-inch one, one with folded dimensions and one with no diagonal do not", async () => {
      const images: readonly FitImage[] = [
        ["35", "google_apis", "arm64-v8a"],
        ["36", "tablet", "arm64-v8a"],
      ];
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ diagonal: "10.1", name: "Big" }) +
          customFitXml({ diagonal: "6", name: "Small" }) +
          customFitXml({ diagonal: "10.1", folded: true, name: "Folds" }) +
          customFitXml({ name: "NoDiagonal" }),
        listing: userListing(["Big"], ["Small"], ["Folds"], ["NoDiagonal"]),
      });

      const { modelRuntimes } = await part.listCatalog();

      expect(modelRuntimes["Big"]).toEqual(["35", "36"]);
      expect(modelRuntimes["Small"]).toEqual(["35"]);
      expect(modelRuntimes["Folds"]).toEqual(["35"]);
      expect(modelRuntimes["NoDiagonal"]).toEqual(["35"]);
    });

    it("a custom profile with nothing but a name pairs as after #489", async () => {
      const { part } = await fitHarness(HOST_IMAGES, {
        devicesXml: customFitXml({ name: "Old" }),
        listing: userListing(["Old"]),
      });

      expect((await part.listCatalog()).modelRuntimes["Old"]).toEqual(["35", "36"]);
    });

    it("a custom profile's class still comes from avdmanager's Tag line", async () => {
      const { part } = await fitHarness(HOST_IMAGES, {
        devicesXml: customFitXml({ name: "My TV", tagId: "android-wear" }),
        listing: userListing(["My TV", "android-tv"]),
      });

      expect((await part.listCatalog()).modelClasses["My TV"]).toBe("tv");
    });

    it("a devices.xml profile avdmanager does not list fits by its own tag-id, range, Play Store flag and screen, and is classed by its tag-id", async () => {
      const images: readonly FitImage[] = [
        ["30", "android-tv", "arm64-v8a"],
        ["31", "android-tv", "arm64-v8a"],
        ["30", "google_apis", "arm64-v8a"],
        ["31", "google_apis_playstore", "arm64-v8a"],
        ["32", "google_apis", "arm64-v8a"],
        ["33", "tablet", "arm64-v8a"],
      ];
      const { part } = await fitHarness(images, {
        devicesXml:
          customFitXml({ apiLevel: "31-", name: "Only TV", tagId: "android-tv" }) +
          customFitXml({ name: "Only Phone", playStore: "false" }) +
          customFitXml({ diagonal: "10.1", name: "Only Tablet" }),
        listing: userListing(),
      });

      const catalog = await part.listCatalog();

      expect(catalog.modelRuntimes["Only TV"]).toEqual(["31"]);
      expect(catalog.modelRuntimes["Only Phone"]).toEqual(["30", "32"]);
      expect(catalog.modelRuntimes["Only Tablet"]).toEqual(["30", "31", "32", "33"]);
      expect(catalog.modelClasses["Only TV"]).toBe("tv");
      expect(catalog.modelClasses["Only Phone"]).toBe("phone");
    });

    it("reads devices.xml from ANDROID_USER_HOME, then ANDROID_PREFS_ROOT, then ANDROID_SDK_HOME, then home", async () => {
      const paths = [
        "/user-home/devices.xml",
        "/prefs/.android/devices.xml",
        "/sdk-home/.android/devices.xml",
        `${home}/.android/devices.xml`,
      ];
      const env = {
        ANDROID_PREFS_ROOT: "/prefs",
        ANDROID_SDK_HOME: "/sdk-home",
        ANDROID_USER_HOME: "/user-home",
      };
      const names = ["From user home", "From prefs root", "From sdk home", "From home"];
      const outcomes: string[][] = [];
      for (let first = 0; first < paths.length; first++) {
        const used: Record<string, string> = {};
        if (first <= 0) used["ANDROID_USER_HOME"] = env.ANDROID_USER_HOME;
        if (first <= 1) used["ANDROID_PREFS_ROOT"] = env.ANDROID_PREFS_ROOT;
        if (first <= 2) used["ANDROID_SDK_HOME"] = env.ANDROID_SDK_HOME;
        const { part, filesystem } = await fitHarness(HOST_IMAGES, {
          extraEnv: used,
          listing: userListing(),
        });
        for (const [index, path] of paths.entries()) {
          await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
          await filesystem.writeFileAtomic(
            path,
            `<?xml version="1.0"?><d:devices xmlns:d="http://schemas.android.com/sdk/devices/7">${customFitXml({ name: names[index] as string })}</d:devices>`,
          );
        }
        outcomes.push(
          (await part.listCatalog()).models.filter((model) => model.startsWith("From ")),
        );
      }

      expect(outcomes).toEqual(names.map((name) => [name]));
    });
  });
});
