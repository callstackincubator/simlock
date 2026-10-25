export type Fields = Record<string, unknown>;

export function asRecord(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

export const present = (value: unknown): boolean => value !== undefined && value !== null;

const STRING_FIELDS = [
  "platform",
  "target",
  "udid",
  "serial",
  "device",
  "deviceKey",
  "osVersion",
  "imageTag",
] as const;
const BOOLEAN_FIELDS = ["physical"] as const;
const INTEGER_FIELDS = ["shardAll", "shardSplit"] as const;

export function malformedField(source: Fields): string | undefined {
  for (const field of STRING_FIELDS) {
    if (present(source[field]) && typeof source[field] !== "string") return field;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (present(source[field]) && typeof source[field] !== "boolean") return field;
  }
  for (const field of INTEGER_FIELDS) {
    if (present(source[field]) && !Number.isInteger(source[field])) return field;
  }
  return undefined;
}

export function normalizeDeviceName(name: string): string {
  return name.toLowerCase().replaceAll("_", " ").replace(/ +/g, " ").trim();
}

export function deviceList(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function commandName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// why: iOS devices are addressed by `udid` and Android ones by `serial`; the front names the address in both its allocate and its rewrites.
export const addressField = (platform: string | undefined): "udid" | "serial" =>
  platform === "android" ? "serial" : "udid";
