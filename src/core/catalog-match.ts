import type { DeviceClass } from "./domain.js";

/** The part of a platform catalog entry that says which names a model answers to. */
interface CatalogNames {
  readonly models: readonly string[];
  readonly modelAliases: Readonly<Record<string, readonly string[]>>;
}

/**
 * The first entry of `models` whose name or whose `modelAliases` entry equals `name`, ignoring
 * letter case, as the listed spelling. A name a request or a preference list uses is a claim
 * about this host; this is how it is checked against what the catalog lists.
 */
export function findCatalogModel(entry: CatalogNames, name: string): string | undefined {
  const wanted = fold(name);
  return entry.models.find(
    (model) =>
      fold(model) === wanted ||
      ownList(entry.modelAliases, model).some((alias) => fold(alias) === wanted),
  );
}

/** Locale-independent, so two hosts on different locales fold a name alike. */
function fold(name: string): string {
  return name.toLowerCase();
}

/** A record lookup that ignores inherited keys, so a model named `constructor` reads nothing. */
function ownList(
  record: Readonly<Record<string, readonly string[]>>,
  key: string,
): readonly string[] {
  return (Object.hasOwn(record, key) ? record[key] : undefined) ?? [];
}

/** A model's class in a catalog entry; an inherited key like `constructor` is no class. */
export function modelClass(
  entry: { readonly modelClasses: Readonly<Record<string, DeviceClass>> },
  model: string,
): DeviceClass | undefined {
  return Object.hasOwn(entry.modelClasses, model) ? entry.modelClasses[model] : undefined;
}

/** The installed runtimes a model pairs with, reading own keys only. */
export function pairedRuntimes(
  entry: { readonly modelRuntimes: Readonly<Record<string, readonly string[]>> },
  model: string,
): readonly string[] {
  return (Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined) ?? [];
}
