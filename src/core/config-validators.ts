import type { ZodType } from "zod";

import type { LogLevel } from "../ports/index.js";
import type { AuthStrategyDefinition } from "../auth/index.js";
import {
  capacityStrategyNames,
  capacityStrategyValidator,
  resourceOptionValidators,
  type CapacityStrategyName,
} from "./capacity/index.js";
import { DEVICE_CLASSES, type LeaseIdentity, type Platform } from "./domain.js";
import { alertDestinationsValidator } from "./config-alerts.js";
import {
  ADMISSION_ARGUMENT_MAX_LENGTH,
  ADMISSION_COMMAND_MAX_ENTRIES,
  ADMISSION_TIMEOUT_MAX_MS,
} from "./config-defaults.js";
import {
  ROUTING_POLICIES,
  type DownloadPolicy,
  type DriverConfigEntry,
  type ModuleConfigEntry,
} from "./config-types.js";
import {
  booleanValue,
  integerInRange,
  invalidValue,
  nonNegativeNumber,
  numberAtLeast,
  numberInRange,
  objectValidator,
  positiveInteger,
  positiveNumber,
  requireObject,
  stringUnion,
  stringValue,
  type Validator,
  type Warn,
} from "./validation.js";
import { warmPoolConfigValidator } from "./warm-pool/index.js";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const DOWNLOAD_POLICIES: readonly DownloadPolicy[] = ["never", "on-request", "always"];
const LEASE_IDENTITIES: readonly LeaseIdentity[] = ["reusable", "fresh"];

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;
const HEADER_VALUE_PATTERN = /^[\t -~]*$/;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_HEADER_CHARACTERS = 8192;
const SIMLOCK_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "x-simlock-worker-id",
  "x-simlock-worker-label",
  "host",
  "connection",
  "upgrade",
  "origin",
]);

type HeaderEntry = [name: string, text: string];

/**
 * why: Node throws on a header name or value it cannot send, so every such entry is refused
 * here at load, where the operator sees the key, rather than on each dial.
 */
function headersValidator(value: unknown, path: string): Readonly<Record<string, string>> {
  const shape = "an object of header names to text values";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue(path, shape);
  }
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is HeaderEntry => typeof entry[1] === "string")) {
    throw invalidValue(path, shape);
  }
  if (entries.length > MAX_HEADERS) throw invalidValue(path, "at most 16 headers");
  checkHeaderNames(entries, path);
  checkHeaderValues(entries, path);
  for (const [name] of entries) {
    const lower = name.toLowerCase();
    if (SIMLOCK_HEADER_NAMES.has(lower) || lower.startsWith("sec-websocket-")) {
      throw invalidValue(path, `no header Simlock sets itself (${name})`);
    }
  }
  return Object.fromEntries(entries);
}

function admissionCommandValidator(value: unknown, path: string): readonly string[] {
  const shape = `a list of 1 to ${String(ADMISSION_COMMAND_MAX_ENTRIES)} strings of 1 to ${String(ADMISSION_ARGUMENT_MAX_LENGTH)} characters`;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ADMISSION_COMMAND_MAX_ENTRIES ||
    !value.every(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length >= 1 &&
        entry.length <= ADMISSION_ARGUMENT_MAX_LENGTH,
    )
  ) {
    throw invalidValue(path, shape);
  }
  return value;
}

function admissionTimeoutValidator(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > ADMISSION_TIMEOUT_MAX_MS
  ) {
    throw invalidValue(path, `an integer from 1 to ${String(ADMISSION_TIMEOUT_MAX_MS)}`);
  }
  return value;
}

function checkHeaderNames(entries: readonly HeaderEntry[], path: string): void {
  const seen = new Set<string>();
  for (const [name] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw invalidValue(
        path,
        `a header name of 1 to 100 letters, digits and HTTP name symbols (got ${name})`,
      );
    }
  }
  for (const [name] of entries) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw invalidValue(path, `each header name once (got ${name} twice)`);
    seen.add(lower);
  }
}

function checkHeaderValues(entries: readonly HeaderEntry[], path: string): void {
  let total = 0;
  for (const [name, text] of entries) {
    if (text.length > MAX_HEADER_VALUE_LENGTH || !HEADER_VALUE_PATTERN.test(text)) {
      throw invalidValue(
        path,
        `a header value of at most 4096 plain ASCII characters (in ${name})`,
      );
    }
    total += name.length + text.length;
  }
  if (total > MAX_HEADER_CHARACTERS) {
    throw invalidValue(path, "at most 8192 characters of header names and values in all");
  }
}

/**
 * why: The `capacity.config` validator is the selected strategy's own, so a strategy
 * owns its options end to end and nothing here has to know their shape.
 */
export function configValidators(
  strategy: CapacityStrategyName,
  modules: readonly ModuleConfigEntry[],
  authStrategies: readonly AuthStrategyDefinition[],
  driverSections: readonly DriverConfigEntry[] = [],
): Record<string, Validator> {
  return {
    capabilities: capabilitiesValidator(modules),
    gateway: objectValidator({
      url: stringValue,
      token: stringValue,
      label: stringValue,
      headers: headersValidator,
      disconnectedRetentionMs: positiveNumber,
      execTimeoutMs: positiveNumber,
      leaseRequestTimeoutMs: positiveNumber,
      routing: stringUnion(ROUTING_POLICIES),
      alerts: objectValidator({ destinations: alertDestinationsValidator }),
      admission: objectValidator({
        command: admissionCommandValidator,
        timeoutMs: admissionTimeoutValidator,
      }),
    }),
    capacity: objectValidator({
      strategy: stringUnion(capacityStrategyNames),
      config: capacityStrategyValidator(strategy),
    }),
    // why: Legacy spelling of the resource options; still type-checked here so a typo
    // inside them is still reported rather than silently dropped.
    ...resourceOptionValidators,
    drivers: driversValidator,
    downloads: objectValidator({
      policy: stringUnion(DOWNLOAD_POLICIES),
      acceptAndroidLicenses: booleanValue,
      timeoutMs: positiveNumber,
    }),
    idle: objectValidator({ shutdownAfterMs: nonNegativeNumber, deleteAfterMs: nonNegativeNumber }),
    update: objectValidator({ check: booleanValue }),
    warmPool: objectValidator({
      ...warmPoolConfigValidator,
      quarantine: objectValidator({
        maxRetries: positiveInteger,
        retryBackoffMs: nonNegativeNumber,
        retryBackoffMultiplier: numberAtLeast(1),
        maxRetryBackoffMs: nonNegativeNumber,
      }),
    }),
    // why: The three pre-ADR-0004 keys (`lease.detachedTtlMs`, `lease.heldTtlBackstopMs`,
    // `lease.heartbeatIntervalMs`) are deliberately absent rather than aliased: `objectValidator`
    // warns about each as an unrecognized key and ignores it, so an old config still boots and
    // gets the new key's default rather than the value it wrote.
    devices: objectValidator({ autoEnroll: booleanValue, deletedRetentionMs: positiveNumber }),
    lease: objectValidator({
      defaultTtlMs: positiveNumber,
      maxTtlMs: positiveNumber,
      identity: objectValidator({
        ios: stringUnion(LEASE_IDENTITIES),
        android: stringUnion(LEASE_IDENTITIES),
      }),
      requestRetentionMs: positiveNumber,
      endedIdRetentionMs: positiveNumber,
      maxRequestRecords: positiveInteger,
      maxPerRequester: maxPerRequesterValidator,
      endWaitMs: endWaitValidator,
    }),
    exec: objectValidator({ timeoutMs: positiveNumber }),
    diskPressure: objectValidator({ freeBytesThreshold: nonNegativeNumber }),
    memoryPressure: objectValidator({
      enabled: booleanValue,
      pauseWarming: memoryPressureRuleValidator,
      pauseNewDevices: memoryPressureRuleValidator,
      clearAfterMs: nonNegativeNumber,
    }),
    eventBuffer: objectValidator({ capacity: positiveInteger }),
    log: objectValidator({ level: stringUnion(LOG_LEVELS), rotateBytes: positiveInteger }),
    eventLog: objectValidator({
      retention: positiveInteger,
      maxBytes: positiveInteger,
    }),
    metrics: objectValidator({ retention: positiveInteger }),
    http: objectValidator({
      enabled: booleanValue,
      host: stringValue,
      port: integerInRange(1, 65535),
      ...Object.fromEntries(
        authStrategies.flatMap((definition) =>
          definition.config === undefined
            ? []
            : [[definition.config.key, schemaValidator(definition.config.schema)]],
        ),
      ),
    }),
    health: objectValidator({
      enabled: booleanValue,
      probeIntervalMs: positiveNumber,
      stableObservations: positiveInteger,
      maxRecoveryAttempts: positiveInteger,
      recoveryBackoffMs: positiveNumber,
      maxConcurrentRecoveries: positiveInteger,
    }),
    ios: objectValidator({
      ...driverValidators(driverSections, "ios"),
      defaultMode: stringUnion(["slim", "full"]),
      defaultModels: defaultModelsValidator,
      modes: modesValidator,
      virtualDevices: booleanValue,
    }),
    android: objectValidator({
      ...driverValidators(driverSections, "android"),
      defaultImageTag: imageTagValidator,
      defaultModels: defaultModelsValidator,
      virtualDevices: booleanValue,
    }),
    stalledTransition: objectValidator({
      thresholdMultiplier: numberAtLeast(1),
      minimumThresholdMs: nonNegativeNumber,
    }),
  };
}

const memoryPressureRuleValidator = objectValidator({
  level: stringUnion(["normal", "warn", "critical", "off"]),
  minAvailablePercent: numberInRange(0, 100),
});

function driverValidators(
  driverSections: readonly DriverConfigEntry[],
  platform: Platform,
): Record<string, Validator> {
  return Object.assign(
    {},
    ...driverSections
      .filter((entry) => entry.platform === platform)
      .map((entry) => entry.validators),
  ) as Record<string, Validator>;
}

function schemaValidator(schema: ZodType): Validator {
  return (value, path) => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    if (issue === undefined) throw invalidValue(path, "a valid value");
    const issuePath = [path, ...issue.path.map(String)].join(".");
    // why: a strategy's own messages are lower-case phrases that finish "expected ..."; zod's built-in ones start with a capital.
    const expected = /^[A-Z]/.test(issue.message)
      ? `a valid value (${issue.message})`
      : issue.message;
    throw invalidValue(issuePath, expected);
  };
}

function capabilitiesValidator(modules: readonly ModuleConfigEntry[]): Validator {
  return (value, path, warn) => {
    const result: Record<string, unknown> = {};
    for (const [name, section] of Object.entries(requireObject(value, path))) {
      const sectionPath = `${path}.${name}`;
      const entry = modules.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        warn(`Unknown config key: "${sectionPath}"`);
        continue;
      }
      const { enabled, ...rest } = requireObject(section, sectionPath);
      result[name] = {
        ...(entry.validator(rest, sectionPath, warn) as Record<string, unknown>),
        ...(enabled === undefined
          ? {}
          : { enabled: booleanValue(enabled, `${sectionPath}.enabled`) }),
      };
    }
    return result;
  };
}

/** why: `setTimeout` fires after about 1 ms above this delay, which would end the wait at once. */
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

const endWaitValidator: Validator = (value, path) => {
  const wait = positiveNumber(value, path);
  if (wait > MAXIMUM_TIMER_DELAY_MS) {
    throw invalidValue(path, `a positive number no larger than ${MAXIMUM_TIMER_DELAY_MS}`);
  }
  return wait;
};

/** why: the bounds of `imageTagSchema` (contract), so a tag the operator sets is one a request could name; the pattern is repeated here, not imported. */
const imageTagValidator: Validator = (value, path) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) {
    throw invalidValue(path, "an image tag: 1 to 64 letters, digits, '_', '.' or '-'");
  }
  return value;
};

/** why: ADR 0082 §1: the iOS modes a worker serves are `slim`, `full` or both, each once; a repeat or an unknown name is refused rather than ignored so the list says what the worker does. */
const modesValidator: Validator = (value, path) => {
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((mode) => mode === "slim" || mode === "full") &&
    new Set(value).size === value.length;
  if (!valid) throw invalidValue(path, 'a non-empty list of "slim" and "full", each once');
  return value as readonly ("slim" | "full")[];
};

/**
 * why: Each key is a device class and each value one non-empty model name or a non-empty list of
 * them, stored as a list. Any other key is refused rather than warned about: a misspelled class
 * would otherwise leave the operator's preference silently unused.
 */
const defaultModelsValidator: Validator = (value, path) => {
  const object = requireObject(value, path);
  const result: Record<string, readonly string[]> = {};

  for (const [key, names] of Object.entries(object)) {
    const keyPath = `${path}.${key}`;
    if (!(DEVICE_CLASSES as readonly string[]).includes(key)) {
      throw invalidValue(keyPath, `a device class (${DEVICE_CLASSES.join(", ")})`);
    }
    const list = typeof names === "string" ? [names] : names;
    if (!Array.isArray(list) || list.length === 0 || !list.every(isNonEmptyString)) {
      throw invalidValue(keyPath, "a model name or a non-empty list of model names");
    }
    result[key] = list;
  }

  return result;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * why: Checks the shape of `drivers` and nothing else. Every leaf is type-checked, because a
 * config file is hand-edited and a nested object or array there is a mistake worth
 * naming -- but an unrecognised key inside a driver block is deliberately *not* a
 * warning. The core does not know which keys a driver has, and warning about the ones it
 * has not heard of would be the same leak as interpreting them.
 */
const driversValidator: Validator = (value, path) => {
  const drivers = requireObject(value, path);

  return Object.fromEntries(
    Object.entries(drivers).map(([name, block]) => [
      name,
      driverSettings(block, `${path}.${name}`),
    ]),
  );
};

function driverSettings(value: unknown, path: string): Record<string, string | number | boolean> {
  const settings = requireObject(value, path);
  const result: Record<string, string | number | boolean> = {};

  for (const [key, leaf] of Object.entries(settings)) {
    if (typeof leaf !== "string" && typeof leaf !== "number" && typeof leaf !== "boolean") {
      throw invalidValue(`${path}.${key}`, "a string, number, or boolean");
    }

    result[key] = leaf;
  }

  return result;
}

function maxPerRequesterValidator(value: unknown, path: string, warn: Warn): unknown {
  return typeof value === "object" && value !== null
    ? objectValidator({ ios: positiveInteger, android: positiveInteger })(value, path, warn)
    : positiveInteger(value, path);
}
