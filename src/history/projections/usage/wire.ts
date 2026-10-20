const MAX_STRING = 200;

type Payload = Readonly<Record<string, unknown>>;

export function payloadOf(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

/** why: a relayed payload is a claim, so a string is cut to a bound and anything else is absent. */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.slice(0, MAX_STRING);
}

export function amount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

export function oneOf<Allowed extends string>(
  value: unknown,
  allowed: readonly Allowed[],
): Allowed | undefined {
  return allowed.find((candidate) => candidate === value);
}

// why: an enum from a relayed payload is one of the known values or absent, so a hostile worker cannot mint platform keys.
export const PLATFORMS = ["ios", "android"] as const;
export const SOURCES = ["warm", "booted", "provisioned"] as const;
export const END_REASONS = ["explicit", "killed", "device-lost", "expired"] as const;

interface Spec {
  readonly platform: string | undefined;
  readonly model: string | undefined;
}

export function specOf(value: unknown): Spec {
  const spec = payloadOf(value);
  return { model: text(spec.model), platform: oneOf(spec.platform, PLATFORMS) };
}
