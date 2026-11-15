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
  const url = value.replace(/\/+$/u, "");
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

export function checkOptions(options: SimlockDevicesOptions): ProviderOptions {
  const given = options as unknown as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!KNOWN.has(name)) fail(`unknown option ${show(name)}`);
  }
  const url = checkUrl(given["url"]);
  if (typeof given["token"] !== "string" || given["token"] === "") {
    fail("token is required (a simlock agent token)");
  }
  const platform = given["platform"];
  if (platform !== "ios" && platform !== "android") {
    fail(`platform must be "ios" or "android"; got ${show(platform)}`);
  }
  if (typeof given["device"] !== "string" || given["device"] === "") {
    fail("device is required (a model the farm lists)");
  }
  const deviceMode = given["deviceMode"];
  if (deviceMode !== undefined && deviceMode !== "slim" && deviceMode !== "full") {
    fail(`deviceMode must be "slim" or "full"; got ${show(deviceMode)}`);
  }
  const extraApps = given["extraApps"] ?? [];
  if (!Array.isArray(extraApps) || !extraApps.every((app) => typeof app === "string")) {
    fail("extraApps must be a list of paths");
  }
  const osVersion = checkOptionalString("osVersion", given["osVersion"]);
  const imageTag = checkOptionalString("imageTag", given["imageTag"]);
  const deviceBaseline = checkOptionalString("deviceBaseline", given["deviceBaseline"]);
  return {
    url,
    token: given["token"],
    platform,
    device: given["device"],
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
