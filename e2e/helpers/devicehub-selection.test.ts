import { describe, expect, it } from "vitest";

import { selectedDeviceFromPlist } from "./devicehub-selection.js";

// why: pure parsing of a plist, used by the slow lane only, which has no fast seam to test it through.
describe("selectedDeviceFromPlist", () => {
  it("reads the whole UDID of a 36-character identifier from DeviceHub's exported defaults", () => {
    const udid = "595102C9-3044-4770-95F8-C55C5B8501E2";
    const data = Buffer.from(`"${udid}"`).toString("base64");
    const plist = `<plist><dict>\n\t<key>lastSelectedDeviceIdentifier</key>\n\t<data>\n\t${data}\n\t</data>\n</dict></plist>`;
    expect(selectedDeviceFromPlist(plist)).toBe(udid);
  });

  it("answers an empty string when DeviceHub has selected nothing", () => {
    expect(selectedDeviceFromPlist("<plist><dict></dict></plist>")).toBe("");
  });
});
