import type { DeviceClass } from "./domain.js";

interface CatalogNames {
  readonly models: readonly string[];
  readonly modelAliases: Readonly<Record<string, readonly string[]>>;
}

export function findCatalogModel(entry: CatalogNames, name: string): string | undefined {
  const wanted = fold(name);
  return entry.models.find(
    (model) =>
      fold(model) === wanted ||
      ownList(entry.modelAliases, model).some((alias) => fold(alias) === wanted),
  );
}

/** why: Locale-independent, so two hosts on different locales fold a name alike. */
function fold(name: string): string {
  return name.toLowerCase();
}

/** why: A record lookup that ignores inherited keys, so a model named `constructor` reads nothing. */
function ownList(
  record: Readonly<Record<string, readonly string[]>>,
  key: string,
): readonly string[] {
  return (Object.hasOwn(record, key) ? record[key] : undefined) ?? [];
}

/** why: A model's class in a catalog entry; an inherited key like `constructor` is no class. */
export function modelClass(
  entry: { readonly modelClasses: Readonly<Record<string, DeviceClass>> },
  model: string,
): DeviceClass | undefined {
  return Object.hasOwn(entry.modelClasses, model) ? entry.modelClasses[model] : undefined;
}

export function pairedRuntimes(
  entry: { readonly modelRuntimes: Readonly<Record<string, readonly string[]>> },
  model: string,
): readonly string[] {
  return (Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined) ?? [];
}

export function classCandidates(
  entry: CatalogNames & { readonly modelClasses: Readonly<Record<string, DeviceClass>> },
  deviceClass: DeviceClass,
  preferences: readonly string[],
): readonly string[] {
  return preferences.flatMap((name) => {
    const model = findCatalogModel(entry, name);
    return model !== undefined && modelClass(entry, model) === deviceClass ? [model] : [];
  });
}
