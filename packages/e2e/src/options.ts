export interface SimlockDevicesOptions {
  url: string;
  token: string;
  platform: "ios" | "android";
  device: string;
  osVersion?: string | undefined;
  imageTag?: string | undefined;
  deviceMode?: "slim" | "full" | undefined;
  deviceBaseline?: string | undefined;
  extraApps?: readonly string[] | undefined;
  ttlMs?: number | undefined;
  queueMs?: number | undefined;
  installConcurrency?: number | undefined;
}

export interface ProviderOptions {
  url: string;
  token: string;
  platform: "ios" | "android";
  device: string;
  osVersion?: string;
  imageTag?: string;
  deviceMode?: "slim" | "full";
  deviceBaseline?: string;
  extraApps: readonly string[];
  ttlMs: number;
  queueMs: number;
  installConcurrency: number;
}

const KNOWN = new Set([
  "url",
  "token",
  "platform",
  "device",
  "osVersion",
  "imageTag",
  "deviceMode",
  "deviceBaseline",
  "extraApps",
  "ttlMs",
  "queueMs",
  "installConcurrency",
]);

const DEFAULT_TTL_MS = 180_000;
const DEFAULT_QUEUE_MS = 1_200_000;
const DEFAULT_INSTALL_CONCURRENCY = 3;
const MIN_TTL_MS = 30_000;

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function fail(message: string): never {
  throw new Error(`simlockDevices: ${message}`);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function checkUrl(value: unknown): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(String(value));
  } catch {
    parsed = undefined;
  }
  if (
    typeof value !== "string" ||
    (parsed?.protocol !== "http:" && parsed?.protocol !== "https:")
  ) {
    fail(`url must be an http(s) URL of the simlock gateway or worker; got ${show(value)}`);
  }
  const url = stripTrailingSlashes(value);
  if (url.endsWith("/v1")) fail(`url must not end in /v1; got ${show(value)}`);
  return url;
}

function checkOptionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") {
    fail(`${name} must be a non-empty string; got ${show(value)}`);
  }
  return value;
}

function checkNumber(
  name: string,
  value: unknown,
  fallback: number,
  accepts: (n: number) => boolean,
  rule: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !accepts(value)) {
    fail(`${name} must be ${rule}; got ${show(value)}`);
  }
  return value;
}

function checkRequired(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "") fail(message);
  return value;
}

function checkPlatform(value: unknown): "ios" | "android" {
  if (value !== "ios" && value !== "android") {
    fail(`platform must be "ios" or "android"; got ${show(value)}`);
  }
  return value;
}

function checkDeviceMode(value: unknown): "slim" | "full" | undefined {
  if (value !== undefined && value !== "slim" && value !== "full") {
    fail(`deviceMode must be "slim" or "full"; got ${show(value)}`);
  }
  return value;
}

function checkExtraApps(value: unknown): readonly string[] {
  const apps = value ?? [];
  if (!Array.isArray(apps) || !apps.every((app) => typeof app === "string")) {
    fail("extraApps must be a list of paths");
  }
  return apps;
}

export function checkOptions(options: SimlockDevicesOptions): ProviderOptions {
  const given = options as unknown as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!KNOWN.has(name)) fail(`unknown option ${show(name)}`);
  }
  const url = checkUrl(given["url"]);
  const token = checkRequired(given["token"], "token is required (a simlock agent token)");
  const platform = checkPlatform(given["platform"]);
  const device = checkRequired(given["device"], "device is required (a model the farm lists)");
  const deviceMode = checkDeviceMode(given["deviceMode"]);
  const extraApps = checkExtraApps(given["extraApps"]);
  const osVersion = checkOptionalString("osVersion", given["osVersion"]);
  const imageTag = checkOptionalString("imageTag", given["imageTag"]);
  const deviceBaseline = checkOptionalString("deviceBaseline", given["deviceBaseline"]);
  return {
    url,
    token,
    platform,
    device,
    ...(osVersion === undefined ? {} : { osVersion }),
    ...(imageTag === undefined ? {} : { imageTag }),
    ...(deviceMode === undefined ? {} : { deviceMode }),
    ...(deviceBaseline === undefined ? {} : { deviceBaseline }),
    extraApps,
    ttlMs: checkNumber(
      "ttlMs",
      given["ttlMs"],
      DEFAULT_TTL_MS,
      (n) => n >= MIN_TTL_MS,
      `a number of at least ${MIN_TTL_MS}`,
    ),
    queueMs: checkNumber(
      "queueMs",
      given["queueMs"],
      DEFAULT_QUEUE_MS,
      (n) => n > 0,
      "a positive number",
    ),
    installConcurrency: checkNumber(
      "installConcurrency",
      given["installConcurrency"],
      DEFAULT_INSTALL_CONCURRENCY,
      (n) => Number.isInteger(n) && n >= 1,
      "a whole number of at least 1",
    ),
  };
}
