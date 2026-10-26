import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { authStrategies } from "../auth/index.js";
import { optionalModules } from "../module-registry/index.js";
import { capacityStrategyNames } from "./capacity/index.js";
import { configValidators, type ModuleConfigEntry } from "./config.js";
import { type Validator, validatorShape } from "./validation.js";

const REFERENCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "website",
  "src",
  "content",
  "docs",
  "docs",
  "reference",
  "configuration.mdx",
);

const modules: ModuleConfigEntry[] = optionalModules.map(({ config, name }) => ({
  name,
  ...config,
}));

function keyPaths(validator: Validator, path: string): string[] {
  const shape = validatorShape(validator);
  if (shape === undefined) return [path];
  return Object.entries(shape).flatMap(([key, child]) => keyPaths(child, `${path}.${key}`));
}

function moduleKeys(): string[] {
  return modules.flatMap(({ name, validator }) => [
    `capabilities.${name}.enabled`,
    ...keyPaths(validator, `capabilities.${name}`),
  ]);
}

function authKeys(): string[] {
  return authStrategies.flatMap((strategy) => {
    const schema = strategy.config?.schema;
    if (!(schema instanceof z.ZodObject)) return [];
    return Object.keys(schema.shape).map((key) => `http.${strategy.config!.key}.${key}`);
  });
}

// why: `capabilities` and an auth strategy's block are validated by closures over the module
// and strategy lists, so their keys come from those lists; every other key from the shapes.
function acceptedKeys(): string[] {
  const keys = capacityStrategyNames.flatMap((strategy) =>
    Object.entries(configValidators(strategy, modules, authStrategies))
      .filter(([key]) => key !== "capabilities")
      .flatMap(([key, validator]) => keyPaths(validator, key)),
  );
  return [...new Set([...keys, ...moduleKeys(), ...authKeys()])].sort();
}

// why: a row's first cell names its key, sometimes with a placeholder (`ios.defaultModels.<class>`)
// or as the parent of keys listed in a table of their own (`warmPool.targets`).
function documentedKeys(): string[] {
  return readFileSync(REFERENCE, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
}

// why: the old top-level spelling of `capacity.config.limits` and `.ramBudget`; the page names
// it once and documents each key under `capacity.config`.
const LEGACY = new Set(["limits", "ramBudget"]);

// why: the keys a validator accepts live in the closures config.ts and validation.ts build, and
// no index exports them; this test reads them where they are made to hold the website to them.
describe("website reference/configuration.mdx", () => {
  it("names every key the config validator accepts in the first cell of a table row", () => {
    const documented = documentedKeys();
    const covered = (key: string): boolean => {
      const top = key.split(".")[0]!;
      if (LEGACY.has(top) && documented.includes(top)) return covered(`capacity.config.${key}`);
      return documented.some((d) => d === key || d.startsWith(`${key}.`));
    };

    expect(acceptedKeys().filter((key) => !covered(key))).toEqual([]);
  });
});
