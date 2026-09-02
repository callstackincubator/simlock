/**
 * Validator primitives shared by the config loader and by capacity strategy
 * definitions, which validate their own options block.
 */

export type Warn = (message: string) => void;

export type Validator = (value: unknown, path: string, warn: Warn) => unknown;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function invalidValue(path: string, expected: string): ConfigError {
  return new ConfigError(`Invalid config value for "${path}": expected ${expected}`);
}

export function objectValidator(shape: Record<string, Validator>): Validator {
  return (value, path, warn) => {
    const object = requireObject(value, path);
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(object)) {
      const childPath = `${path}.${key}`;
      const validator = shape[key];

      if (validator === undefined) {
        warn(`Unknown config key: "${childPath}"`);
        continue;
      }

      result[key] = validator(child, childPath, warn);
    }

    return result;
  };
}

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidValue(path, "an object");
  }

  return value as Record<string, unknown>;
}

export function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidValue(path, "a positive integer");
  }

  return value;
}

export function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidValue(path, "a non-negative number");
  }

  return value;
}

export function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidValue(path, "a positive number");
  }

  return value;
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidValue(path, "a boolean");
  }

  return value;
}

export function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw invalidValue(path, "a string");
  }

  return value;
}

export function numberAtLeast(minimum: number): Validator {
  return (value: unknown, path: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
      throw invalidValue(path, `a number >= ${minimum}`);
    }

    return value;
  };
}

export function integerInRange(minimum: number, maximum: number): Validator {
  return (value: unknown, path: string) => {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw invalidValue(path, `an integer between ${minimum} and ${maximum}`);
    }

    return value;
  };
}

export function stringArray(value: unknown, path: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw invalidValue(path, "an array of strings");
  }

  return value as readonly string[];
}

export function stringUnion<Value extends string>(
  allowed: readonly Value[],
  describe: (allowed: readonly Value[]) => string = (values) =>
    `one of ${values.map((value) => `"${value}"`).join(", ")}`,
): (value: unknown, path: string) => Value {
  return (value, path) => {
    if (typeof value !== "string" || !allowed.includes(value as Value)) {
      throw invalidValue(path, describe(allowed));
    }

    return value as Value;
  };
}
