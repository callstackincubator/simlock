import { describe, expect, it } from "vitest";

import { projectName } from "./index.js";

describe("projectName", () => {
  it("identifies the project", () => {
    expect(projectName).toBe("pitlane");
  });
});
