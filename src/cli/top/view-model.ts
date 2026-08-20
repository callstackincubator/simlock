/**
 * Pure view-model for `pitlane top`: turns the raw, untrusted `status.get` /
 * `config.get` daemon responses into a typed, render-ready shape, plus all
 * the small derivations (classification, sorting, meter math, duration
 * formatting, event summaries) the Ink layer needs.
 *
 * Nothing here imports Ink or React, and nothing here throws on malformed
 * input — nothing is trusted at this boundary, so every read is defensive.
 * This is deliberate: it is the only part of `pitlane top` worth unit
 * testing, and it stays testable by staying pure.
 */

export type Platform = "ios" | "android";
export type RowState = "leased" | "warm" | "busy" | "shutdown";
export type Health = "starting" | "running" | "failed";

export interface DeviceRow {
  readonly id: string;
  readonly state: RowState;
  readonly platform: Platform | undefined;
  readonly model: string;
  readonly osVersion: string;
  readonly agent: string | undefined;
  readonly forMs: number;
  /** Only ever set for `warm` rows, and only when a shutdown-after config was supplied. */
  readonly shutdownInMs: number | undefined;
  /** True when the device carries a foreign-state or foreign-provenance drift marker. */
  readonly flagged: boolean;
}

export interface CapacityUsage {
  readonly running: number;
  readonly maxRunning: number;
  readonly reserved: number;
  readonly overLimit: boolean;
  readonly warm: number;
  readonly used: number | undefined;
  readonly limit: number | undefined;
}

export interface Capacity {
  readonly global: CapacityUsage;
  readonly ios: CapacityUsage;
  readonly android: CapacityUsage;
}

export interface RowCounts {
  readonly leased: number;
  readonly warm: number;
  readonly busy: number;
  readonly shutdown: number;
}

export interface TopViewModel {
  readonly health: Health;
  readonly queueDepth: number;
  readonly devices: readonly DeviceRow[];
  readonly capacity: Capacity;
  readonly counts: RowCounts;
  /** True when any capacity bucket (global/ios/android) is over its limit. */
  readonly overLimit: boolean;
}

export interface ParseStatusOptions {
  readonly now: number;
  /** `config.idle.shutdownAfterMs`, fetched once at startup; omit if unavailable. */
  readonly shutdownAfterMs?: number;
}

const ROW_ORDER: Readonly<Record<RowState, number>> = { leased: 0, warm: 1, busy: 2, shutdown: 3 };

export function parseStatus(raw: unknown, options: ParseStatusOptions): TopViewModel {
  const root = isRecord(raw) ? raw : {};
  const now = options.now;

  const leases = (Array.isArray(root.leases) ? root.leases : [])
    .map(parseLease)
    .filter((lease): lease is ParsedLease => lease !== undefined);
  const leaseByDeviceId = new Map(leases.map((lease) => [lease.deviceId, lease]));

  const rawDevices = Array.isArray(root.devices) ? root.devices : [];
  const devices: DeviceRow[] = [];
  for (const entry of rawDevices) {
    const device = parseDevice(entry);
    if (device === undefined || device.state === "deleted") continue;
    devices.push(
      classifyDevice(device, leaseByDeviceId.get(device.id), now, options.shutdownAfterMs),
    );
  }
  devices.sort(compareRows);

  const counts: { leased: number; warm: number; busy: number; shutdown: number } = {
    busy: 0,
    leased: 0,
    shutdown: 0,
    warm: 0,
  };
  for (const device of devices) counts[device.state] += 1;

  const capacityRoot = isRecord(root.capacity) ? root.capacity : {};
  const capacity: Capacity = {
    android: parseCapacityUsage(capacityRoot.android),
    global: parseCapacityUsage(capacityRoot.global),
    ios: parseCapacityUsage(capacityRoot.ios),
  };

  return {
    capacity,
    counts,
    devices,
    health: parseHealth(root.health),
    overLimit: capacity.global.overLimit || capacity.ios.overLimit || capacity.android.overLimit,
    queueDepth:
      typeof root.queueDepth === "number" && Number.isFinite(root.queueDepth) ? root.queueDepth : 0,
  };
}

/** Parses `config.get`'s `idle.shutdownAfterMs`; `undefined` on any missing/invalid shape. */
export function parseIdleShutdownAfterMs(raw: unknown): number | undefined {
  if (!isRecord(raw) || !isRecord(raw.idle)) return undefined;
  return typeof raw.idle.shutdownAfterMs === "number" ? raw.idle.shutdownAfterMs : undefined;
}

interface ParsedDevice {
  readonly id: string;
  readonly state: string;
  readonly platform: Platform | undefined;
  readonly model: string;
  readonly osVersion: string;
  readonly createdAt: number;
  readonly lastLeaseEndedAt: number | undefined;
  readonly flagged: boolean;
}

/** `undefined` for anything that is not a non-empty string; the caller supplies the placeholder. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePlatform(value: unknown): Platform | undefined {
  return value === "ios" || value === "android" ? value : undefined;
}

function parseDevice(raw: unknown): ParsedDevice | undefined {
  if (!isRecord(raw)) return undefined;
  const id = nonEmptyString(raw.id);
  if (id === undefined) return undefined;
  const spec = isRecord(raw.spec) ? raw.spec : {};
  return {
    createdAt: optionalNumber(raw.createdAt) ?? 0,
    flagged:
      raw.foreignStateDetectedAt !== undefined || raw.foreignProvenanceDetectedAt !== undefined,
    id,
    lastLeaseEndedAt: optionalNumber(raw.lastLeaseEndedAt),
    model: nonEmptyString(spec.model) ?? "?",
    osVersion: nonEmptyString(spec.osVersion) ?? "?",
    platform: parsePlatform(spec.platform),
    state: nonEmptyString(raw.state) ?? "shutdown",
  };
}

interface ParsedLease {
  readonly deviceId: string;
  readonly requesterId: string;
  readonly grantedAt: number;
}

function parseLease(raw: unknown): ParsedLease | undefined {
  if (!isRecord(raw) || typeof raw.deviceId !== "string" || raw.deviceId === "") return undefined;
  return {
    deviceId: raw.deviceId,
    grantedAt: typeof raw.grantedAt === "number" ? raw.grantedAt : 0,
    requesterId: typeof raw.requesterId === "string" ? raw.requesterId : "",
  };
}

/**
 * Classification priority: an explicit `leased` state, OR any lease record
 * pointing at this device (the "ready but leased" edge case — a device the
 * daemon reports as `ready` while a lease still references it) both count
 * as `leased`. Then `provisioning`/`reclaiming` are `busy` (there is no
 * separate "booting" state). Then `ready` with no lease is `warm`. Anything
 * else — `shutdown`, or an unrecognized/renamed state — renders as the
 * quiet, dim `shutdown` row rather than crashing or guessing.
 */
function classifyState(device: ParsedDevice, lease: ParsedLease | undefined): RowState {
  if (device.state === "leased" || lease !== undefined) return "leased";
  if (device.state === "provisioning" || device.state === "reclaiming") return "busy";
  return device.state === "ready" ? "warm" : "shutdown";
}

/** The timestamp each row's "for" column counts from, which differs per classification. */
function rowSince(state: RowState, device: ParsedDevice, lease: ParsedLease | undefined): number {
  if (state === "leased") return lease?.grantedAt ?? device.createdAt;
  if (state === "busy") return device.createdAt;
  return device.lastLeaseEndedAt ?? device.createdAt;
}

function classifyDevice(
  device: ParsedDevice,
  lease: ParsedLease | undefined,
  now: number,
  shutdownAfterMs: number | undefined,
): DeviceRow {
  const state = classifyState(device, lease);
  const forMs = nonNegative(now - rowSince(state, device, lease));
  const warmCountdown = state === "warm" && shutdownAfterMs !== undefined;
  return {
    agent: state === "leased" ? lease?.requesterId : undefined,
    flagged: device.flagged,
    forMs,
    id: device.id,
    model: device.model,
    osVersion: device.osVersion,
    platform: device.platform,
    shutdownInMs: warmCountdown ? Math.max(0, shutdownAfterMs - forMs) : undefined,
    state,
  };
}

/**
 * Groups by state, then orders by model *case-insensitively*. A raw `<`
 * comparison sorts by code point, which puts every capitalized model ahead of
 * every lowercase-initial one — `Pixel 8` before `iPhone 17 Pro`, since `P`
 * (80) precedes `i` (105). That reads as broken to anyone scanning the list,
 * so case is folded first and the raw model breaks exact ties to keep the
 * order total and stable.
 */
function compareRows(a: DeviceRow, b: DeviceRow): number {
  const order = ROW_ORDER[a.state] - ROW_ORDER[b.state];
  if (order !== 0) return order;
  const folded = a.model.toLowerCase().localeCompare(b.model.toLowerCase());
  if (folded !== 0) return folded;
  if (a.model < b.model) return -1;
  if (a.model > b.model) return 1;
  return 0;
}

function parseCapacityUsage(raw: unknown): CapacityUsage {
  const record = isRecord(raw) ? raw : {};
  return {
    limit: typeof record.limit === "number" ? record.limit : undefined,
    maxRunning: numberOr(record.maxRunning, 0),
    overLimit: record.overLimit === true,
    reserved: numberOr(record.reserved, 0),
    running: numberOr(record.running, 0),
    used: typeof record.used === "number" ? record.used : undefined,
    warm: numberOr(record.warm, 0),
  };
}

function parseHealth(value: unknown): Health {
  return value === "starting" || value === "running" || value === "failed" ? value : "starting";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Meter
// ---------------------------------------------------------------------------

export type MeterSegmentKind = "leased" | "warm" | "busy" | "empty";

export interface MeterSegment {
  readonly kind: MeterSegmentKind;
  readonly width: number;
}

export interface Meter {
  readonly width: number;
  readonly segments: readonly MeterSegment[];
  /** `running / maxRunning`, clamped to `[0, 1]`; `maxRunning <= 0` reads as 0 (or 1 if `running > 0`). */
  readonly fraction: number;
  readonly overLimit: boolean;
}

const COLORED_KINDS = ["leased", "warm", "busy"] as const;

/**
 * Renders the block-meter as a list of colored segments that sum exactly to
 * `width`. The filled portion (`fraction` of `width`) is split between
 * leased/warm/busy proportionally to `counts`, using largest-remainder
 * allocation so rounding never leaves the segments short or over `width`.
 * `maxRunning === 0` never divides by zero; `running > maxRunning` (over
 * capacity) is reported via `overLimit` regardless of what the daemon itself
 * reported, in addition to trusting `capacity.overLimit`.
 */
/** `running / maxRunning`, clamped; `maxRunning <= 0` reads as full when anything runs, else empty. */
function meterFraction(running: number, maxRunning: number): number {
  if (maxRunning > 0) return Math.min(running / maxRunning, 1);
  return running > 0 ? 1 : 0;
}

/**
 * Largest-remainder allocation of `filledWidth` columns across the colored
 * kinds, proportional to `counts`. Floors first, then hands the leftover
 * columns to the largest fractional parts, so the widths always sum to
 * exactly `filledWidth` instead of drifting with rounding.
 */
function allocateSegmentWidths(
  counts: { readonly leased: number; readonly warm: number; readonly busy: number },
  filledWidth: number,
): Map<MeterSegmentKind, number> {
  const widths = new Map<MeterSegmentKind, number>();
  const total = counts.leased + counts.warm + counts.busy;
  if (total <= 0 || filledWidth <= 0) return widths;

  const exact = COLORED_KINDS.map((kind) => (counts[kind] / total) * filledWidth);
  const floors = exact.map(Math.floor);
  COLORED_KINDS.forEach((kind, index) => widths.set(kind, floors[index] ?? 0));

  const byRemainder = COLORED_KINDS.map((kind, index) => ({
    frac: (exact[index] ?? 0) - (floors[index] ?? 0),
    kind,
  })).sort((a, b) => b.frac - a.frac);
  let remainder = filledWidth - floors.reduce((sum, value) => sum + value, 0);
  for (const { kind } of byRemainder) {
    if (remainder <= 0) break;
    widths.set(kind, (widths.get(kind) ?? 0) + 1);
    remainder -= 1;
  }
  return widths;
}

export function buildMeter(
  counts: { readonly leased: number; readonly warm: number; readonly busy: number },
  capacity: { readonly running: number; readonly maxRunning: number; readonly overLimit: boolean },
  width = 20,
): Meter {
  const fraction = meterFraction(capacity.running, capacity.maxRunning);
  const filledWidth = Math.min(width, Math.max(0, Math.round(fraction * width)));
  const widths = allocateSegmentWidths(counts, filledWidth);

  const segments: MeterSegment[] = [];
  let filledSum = 0;
  for (const kind of COLORED_KINDS) {
    const segmentWidth = widths.get(kind) ?? 0;
    if (segmentWidth > 0) {
      segments.push({ kind, width: segmentWidth });
      filledSum += segmentWidth;
    }
  }
  const emptyWidth = width - filledSum;
  if (emptyWidth > 0) segments.push({ kind: "empty", width: emptyWidth });

  return {
    fraction,
    overLimit: capacity.overLimit || capacity.running > capacity.maxRunning,
    segments,
    width,
  };
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Three formatting schemes, each used where its precision matters:
 *
 * - {@link formatDuration} — precise `M:SS` below an hour, `HhMMm` at/above
 *   an hour. Used for the "for" column on rows the operator watches closely
 *   (leased/warm/busy) and for the warm shutdown countdown, where seconds
 *   are the point.
 * - {@link formatCoarseDuration} — bare `Mm` below an hour, `HhMMm` at/above
 *   an hour. Used where only rough idle time matters (the shutdown row's
 *   "for").
 * - {@link formatRelativeAge} — compact `Ns`/`Nm`/`Nh`/`Nd`. Used for "how
 *   long ago" on the last-event line.
 *
 * All three clamp negative input to zero rather than throwing or printing a
 * negative duration, since clock skew between `now` and a server timestamp
 * is expected, not exceptional.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(nonNegative(ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  return `${minutes}:${pad(seconds)}`;
}

export function formatCoarseDuration(ms: number): string {
  const totalMinutes = Math.floor(nonNegative(ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  return `${minutes}m`;
}

export function formatRelativeAge(ms: number): string {
  const totalSeconds = Math.floor(nonNegative(ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  return `${Math.floor(totalHours / 24)}d`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Event summaries
// ---------------------------------------------------------------------------

export interface EventSummary {
  readonly event: string;
  readonly summary: string;
  readonly ageMs: number;
}

/**
 * Summarizes one pushed event envelope (`{ seq, timestamp, event, payload,
 * module }`) into the single dim line the dashboard footer shows. `label`
 * resolves a device id to a display label (its model, typically) — callers
 * pass a lookup built from the current view model so events about a device
 * that has since been deleted still degrade to showing its raw id.
 */
export function summarizeEvent(
  raw: unknown,
  now: number,
  label: (deviceId: string) => string | undefined,
): EventSummary | undefined {
  if (!isRecord(raw) || typeof raw.event !== "string") return undefined;
  const event = raw.event;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : now;
  return {
    ageMs: nonNegative(now - timestamp),
    event,
    summary: describeEvent(event, payload, label),
  };
}

function deviceText(
  payload: Record<string, unknown>,
  label: (id: string) => string | undefined,
): string {
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : undefined;
  if (deviceId === undefined) return "";
  return label(deviceId) ?? deviceId;
}

// fallow-ignore-next-line complexity -- one flat lookup table of known event names to a short human summary.
function describeEvent(
  event: string,
  payload: Record<string, unknown>,
  label: (id: string) => string | undefined,
): string {
  const device = deviceText(payload, label);
  const requester = typeof payload.requester === "string" ? payload.requester : undefined;
  switch (event) {
    case "lease.granted":
      return requester === undefined ? `→ ${device}` : `${requester} → ${device}`;
    case "lease.released":
      return `${device} (${String(payload.reason ?? "released")})`;
    case "lease.expired":
      return device;
    case "lease.renewed":
      return device === "" ? "lease renewed" : device;
    case "lease.queued":
      return `position ${String(payload.queuePosition ?? "?")}`;
    case "lease.rejected":
      return String(payload.reason ?? "rejected");
    case "device.provisioned":
    case "device.ready":
    case "device.reclaimed":
    case "device.shutdown":
    case "device.deleted":
      return device;
    case "device.purge-failed":
      return `${device} purge failed`;
    case "device.foreign-state-detected":
    case "device.foreign-provenance-detected":
      return `${device} drift detected`;
    case "cleanup.executed":
      return `${String(payload.ruleName ?? "rule")} → ${String(payload.target ?? "")}`;
    case "doctor.reconciled":
      return "reconcile complete";
    case "daemon.started":
      return "daemon started";
    case "daemon.stopping":
      return "daemon stopping";
    case "disk.pressure-detected":
      return "disk pressure";
    case "runtime.deleted":
      return String(payload.runtimeId ?? "");
    default:
      return device;
  }
}

// ---------------------------------------------------------------------------
// Meter line layout
// ---------------------------------------------------------------------------

export interface MeterLayout {
  readonly barWidth: number;
  readonly showPlatforms: boolean;
}

/**
 * Width budget for the meter line, so it can never wrap — a wrapped meter
 * destroys the alignment of every row beneath it. `Running ` + bar + `  n/m`
 * is the irreducible core; the per-platform `   ios n/m   android n/m` tail
 * is dropped first, and only then does the bar itself shrink (to a floor of
 * 6, below which a bar conveys nothing).
 *
 * The table's own breakpoints (72 for AGENT, 60 for OS) are deliberately not
 * reused here: this line's natural width is ~67 columns with single-digit
 * capacities and grows with the digits, so it has to give way on its own
 * measured budget rather than a shared constant.
 */
export function meterLayout(width: number, capacity: Capacity, maxBarWidth: number): MeterLayout {
  const platformTail =
    `   ios ${capacity.ios.running}/${capacity.ios.maxRunning}` +
    `   android ${capacity.android.running}/${capacity.android.maxRunning}`;
  const core =
    2 + "Running ".length + 2 + `${capacity.global.running}/${capacity.global.maxRunning}`.length;
  const showPlatforms = width >= core + maxBarWidth + platformTail.length;
  const available = width - core - (showPlatforms ? platformTail.length : 0);
  return { barWidth: Math.max(6, Math.min(maxBarWidth, available)), showPlatforms };
}

/**
 * Resolves the column budget the dashboard lays out against. A TTY's
 * `stdout.columns` wins; otherwise `COLUMNS` (which Ink's own layout engine
 * honours even on a pipe) keeps our budget and Ink's in agreement; otherwise
 * the conventional 80.
 */
export function resolveWidth(columns: number | undefined, envColumns: string | undefined): number {
  if (typeof columns === "number" && columns > 0) return columns;
  const parsed = Number(envColumns);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}
