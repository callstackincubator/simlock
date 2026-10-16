import { readFileSync } from "node:fs";

export function readPackageVersion(): string {
  // why: `rootDir` is `src`, so the manifest cannot be imported; `../../` reaches it from both `src/ports` and `dist/ports`.
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("package.json has no version");
  }
  return manifest.version;
}
