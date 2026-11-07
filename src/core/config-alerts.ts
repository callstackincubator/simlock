import { invalidValue, requireObject, stringUnion, type Warn } from "./validation.js";

export const ALERT_EVENTS = [
  "worker.connected",
  "worker.disconnected",
  "worker.rejected",
  "worker.drain-started",
  "worker.drain-ended",
  "device.quarantine-abandoned",
  "device.quarantine-stranded",
  "device.recovery-failed",
  "device.stalled-transition-detected",
  "disk.pressure-detected",
  "memory.pressure-changed",
  "component.install-failed",
] as const;
export type AlertEventName = (typeof ALERT_EVENTS)[number];

/**
 * why: re-declared in the contract's `configSchema`, which imports nothing from core; a test checks the two agree.
 */
export const ALERT_FORMATS = ["generic", "slack"] as const;
export type AlertFormatName = (typeof ALERT_FORMATS)[number];

/** why: checked at config load, which cannot import the alerts module. */
const ALERT_FORMAT_SECRET: Record<AlertFormatName, "required" | "refused"> = {
  generic: "required",
  slack: "refused",
};

export interface AlertDestination {
  readonly name: string;
  readonly format: AlertFormatName;
  readonly url: string;
  readonly events: readonly AlertEventName[];
  readonly secret?: string;
}

const MAX_ALERT_DESTINATIONS = 16;
const ALERT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ALERT_LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const ALERT_URL_EXPECTED =
  "an https:// URL, or an http:// URL to localhost, 127.0.0.1 or [::1], with no user name or password";

function isAlertUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ALERT_LOCAL_HOSTS.includes(url.hostname);
}

const ALERT_KEYS = ["name", "format", "url", "events", "secret"];

function checkAlertName(name: unknown, path: string, names: Set<string>): string {
  if (typeof name !== "string" || !ALERT_NAME_PATTERN.test(name)) {
    throw invalidValue(
      `${path}.name`,
      "a name of lowercase letters, digits and dashes that starts with a letter, at most 32 characters",
    );
  }
  if (names.has(name)) throw invalidValue(`${path}.name`, "a name no other destination uses");
  return name;
}

function checkAlertEvents(events: unknown, path: string): AlertEventName[] {
  if (
    !Array.isArray(events) ||
    events.length === 0 ||
    new Set(events).size !== events.length ||
    !events.every((event) => (ALERT_EVENTS as readonly unknown[]).includes(event))
  ) {
    throw invalidValue(
      `${path}.events`,
      `a non-empty list of alert events, each once: ${ALERT_EVENTS.join(", ")}`,
    );
  }
  return events as AlertEventName[];
}

function checkAlertSecret(
  format: AlertFormatName,
  entry: Record<string, unknown>,
  path: string,
): string | undefined {
  const { secret } = entry;
  if (ALERT_FORMAT_SECRET[format] === "refused") {
    if ("secret" in entry) {
      throw invalidValue(`${path}.secret`, `no secret: a ${format} destination is not signed`);
    }
    return undefined;
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw invalidValue(`${path}.secret`, `a non-empty secret for a ${format} destination`);
  }
  return secret;
}

function alertDestinationValidator(
  names: Set<string>,
): (value: unknown, path: string, warn: Warn) => AlertDestination {
  return (value, path, warn) => {
    const entry = requireObject(value, path);
    for (const key of Object.keys(entry)) {
      if (!ALERT_KEYS.includes(key)) warn(`Unknown config key: "${path}.${key}"`);
    }
    // why: the fields are checked in this order, so a destination with several bad ones reports the first.
    const name = checkAlertName(entry.name, path, names);
    const format = stringUnion(ALERT_FORMATS)(entry.format, `${path}.format`);
    if (!isAlertUrl(entry.url)) throw invalidValue(`${path}.url`, ALERT_URL_EXPECTED);
    const events = checkAlertEvents(entry.events, path);
    const secret = checkAlertSecret(format, entry, path);
    names.add(name);
    return {
      name,
      format,
      url: entry.url,
      events,
      ...(secret === undefined ? {} : { secret }),
    };
  };
}

export function alertDestinationsValidator(
  value: unknown,
  path: string,
  warn: Warn,
): AlertDestination[] {
  if (!Array.isArray(value) || value.length > MAX_ALERT_DESTINATIONS) {
    throw invalidValue(path, `a list of at most ${MAX_ALERT_DESTINATIONS} destinations`);
  }
  const validate = alertDestinationValidator(new Set());
  return value.map((entry, index) => validate(entry, `${path}[${index}]`, warn));
}
