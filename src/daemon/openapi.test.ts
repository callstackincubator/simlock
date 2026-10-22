import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openApiDocument, writeOpenApiDocument } from "./openapi.js";

describe("writeOpenApiDocument", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
    );
  });
  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "simlock-openapi-"));
    directories.push(dir);
    return dir;
  }

  it("writes the JSON of openApiDocument(), and with a builder that throws writes no file and rethrows", async () => {
    const dir = await scratch();
    const file = join(dir, "openapi.json");

    await writeOpenApiDocument(file);
    expect(await readdir(dir)).toEqual(["openapi.json"]);
    const written = JSON.parse(await readFile(file, "utf8")) as unknown;

    expect(written).toEqual(JSON.parse(JSON.stringify(openApiDocument())));
    expect(Object.keys((written as { paths: object }).paths)).toContain("/v1/status");

    const failed = join(dir, "failed.json");
    const broken = () => {
      throw new Error("the builder broke");
    };
    await expect(writeOpenApiDocument(failed, broken)).rejects.toThrow("the builder broke");
    expect(await readdir(dir)).toEqual(["openapi.json"]);
  });
});
