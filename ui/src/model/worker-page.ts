import { defined } from "./defined";
import {
  type DeviceSlot,
  hasIssue,
  platformSlots,
  slotsLabel,
  stageLine,
  workerHealth,
  workerSlots,
} from "./fleet";
import { formatBusyPercent, formatBytes, formatCores, loadGauges } from "./load";
import { levelOf } from "./load-thresholds";
import { holderOf, platformName, stateEnteredAt } from "../../../src/contract/inbox";
import { leasePath, type TokenRecord } from "./leases";
import { devicePath } from "./paths";
import { formatDuration } from "./time";
import { type UpdateFacts, updateFactsOf, versionLine } from "./versions";
import {
  connectionStatus,
  deviceStateStatus,
  healthStatus,
  installStatus,
  pressureStatus,
  type Tone,
  type Toned,
} from "./tones";
import {
  capacityByPlatform,
  type WarmPoolRow,
  warmPoolRows,
  type WorkerDevice,
  type WorkerView,
  workerName,
  workerPath,
} from "./workers";

export type WorkerFilter = "all" | "issues" | "busy";

export const WORKER_FILTERS: readonly { readonly value: WorkerFilter; readonly label: string }[] = [
  { label: "All", value: "all" },
  { label: "Issues", value: "issues" },
  { label: "Busy", value: "busy" },
];

// why: a worker is busy once three quarters of the slots it may run are in use, which is where an
// operator starts to wonder whether the next lease will wait.
const BUSY_PERCENT = 75;

export interface WorkerUse {
  readonly running: number;
  readonly limit: number;
  readonly percent: number;
}

export interface RowMeter {
  readonly label: string;
  readonly percent?: number;
  readonly tone: MeterTone;
}

export interface WorkerRow {
  readonly id: string;
  readonly connection: WorkerView["connection"];
  readonly takesLeases: boolean;
  readonly slots: readonly DeviceSlot[];
  readonly slotsLabel: string;
  readonly meters: readonly RowMeter[];
  readonly name: string;
  readonly mono: boolean;
  readonly to: string;
  readonly health: Toned;
  readonly system?: string;
  readonly version?: string;
  readonly stage?: string;
  readonly updateFacts: UpdateFacts;
  readonly use?: WorkerUse;
}

// why: a worker that is not connected keeps the capacity it last reported, which would read as
// slots in use that nobody can lease, so its row says nothing about use.
function useOf(worker: WorkerView): WorkerUse | undefined {
  if (worker.connection !== "connected" || worker.capacity === undefined) return undefined;
  const platforms = capacityByPlatform(worker);
  const running = platforms.reduce((sum, platform) => sum + platform.running, 0);
  const limit = platforms.reduce((sum, platform) => sum + platform.limit, 0);
  return { limit, percent: limit === 0 ? 0 : (running / limit) * 100, running };
}

function systemOf(worker: WorkerView): string | undefined {
  const { host } = worker;
  return host === undefined ? undefined : `${host.os} ${host.osVersion}`;
}

export function workerRow(worker: WorkerView, search = ""): WorkerRow {
  const use = useOf(worker);
  const system = systemOf(worker);
  const slots = workerSlots(worker);
  const updateFacts = updateFactsOf(worker);
  const version = versionLine(updateFacts);
  const health = workerHealth(worker);
  const stage = health.word === "updating" && worker.update ? stageLine(worker.update) : undefined;
  return {
    connection: worker.connection,
    takesLeases: !worker.drained,
    health,
    id: worker.id,
    meters: loadFigures(worker).map((card) => ({
      label: card.label,
      tone: card.tone,
      ...(card.percent === undefined ? {} : { percent: card.percent }),
    })),
    slots,
    slotsLabel: slotsLabel(slots),
    mono: worker.label === undefined,
    name: workerName(worker),
    to: `${workerPath(worker.id)}${search}`,
    updateFacts,
    ...(system === undefined ? {} : { system }),
    ...(version === undefined ? {} : { version }),
    ...(stage === undefined ? {} : { stage }),
    ...(use === undefined ? {} : { use }),
  };
}

// why: the filter lives in the address beside the page, so opening a worker and coming back shows
// the same list the page number was counted in; an unknown value is All.
export function readFilter(search: string): WorkerFilter {
  const asked = new URLSearchParams(search).get("filter");
  return WORKER_FILTERS.find((entry) => entry.value === asked)?.value ?? "all";
}

// why: a new filter starts at the first page, since the page the operator was on may not exist in
// it; the other keys of the query stay.
export function writeFilter(search: string, filter: WorkerFilter): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  if (filter === "all") params.delete("filter");
  else params.set("filter", filter);
  const written = params.toString();
  return written === "" ? "" : `?${written}`;
}

function matches(worker: WorkerView, filter: WorkerFilter): boolean {
  if (filter === "issues") return hasIssue(worker);
  if (filter === "busy") return (useOf(worker)?.percent ?? 0) >= BUSY_PERCENT;
  return true;
}

export function filterWorkers(
  workers: readonly WorkerView[],
  filter: WorkerFilter,
): readonly WorkerView[] {
  return workers.filter((worker) => matches(worker, filter));
}

// why: the search matches any part of what a row shows to identify a worker: its name, its id and
// its system, whatever the case.
export function searchWorkers(
  workers: readonly WorkerView[],
  query: string,
): readonly WorkerView[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return workers;
  return workers.filter((worker) =>
    [workerName(worker), worker.id, systemOf(worker) ?? ""].some((text) =>
      text.toLowerCase().includes(wanted),
    ),
  );
}

export function upMeta(workers: readonly WorkerView[]): string {
  const up = workers.filter((worker) => worker.connection === "connected").length;
  return `${up} / ${workers.length} up`;
}

export type MeterTone = Tone | "neutral";

export interface LoadDetail {
  readonly label: string;
  readonly text: string;
  readonly tone?: Tone;
}

export interface FigureCard {
  readonly label: string;
  readonly text: string;
  readonly percent?: number;
  readonly tone: MeterTone;
  readonly details: readonly LoadDetail[];
}

const UNAVAILABLE = "Unavailable";

function meterTone(tone: Tone): MeterTone {
  return tone === "idle" ? "neutral" : tone;
}

function limited(text: string, isLimited: boolean): string {
  return isLimited ? `${text} (limit)` : text;
}

function figureCards(worker: WorkerView): readonly FigureCard[] {
  const { load } = worker;
  if (load === undefined) return [];
  const gauges = loadGauges(load);
  const { cpu, disk, memory } = load;
  // why: memory has a level the worker sends, its pressure, and takes that tone; where the worker
  // sends none, which is every Linux worker, it falls back to the console's own threshold like the
  // other two, which have nothing to ask the worker for.
  const memoryTone =
    memory?.pressure === undefined ? levelOf(gauges.memory) : pressureStatus(memory.pressure).tone;
  const unavailable = (label: string): FigureCard => ({
    details: [],
    label,
    text: UNAVAILABLE,
    tone: "neutral",
  });
  const withPercent = (percent: number | undefined) => (percent === undefined ? {} : { percent });
  return [
    cpu === undefined
      ? unavailable("CPU")
      : {
          details: [],
          label: "CPU",
          text: limited(
            `${formatBusyPercent(cpu.busyPercent)} busy, ${formatCores(cpu.cores)}`,
            cpu.limited,
          ),
          tone: meterTone(levelOf(gauges.cpu)),
          ...withPercent(gauges.cpu),
        },
    memory === undefined
      ? unavailable("Memory")
      : {
          details: [
            { label: "Swap", text: `${formatBytes(memory.swapUsedBytes)} used` },
            ...(memory.pressure === undefined
              ? []
              : [
                  {
                    label: "Pressure",
                    text: memory.pressure,
                    tone: pressureStatus(memory.pressure).tone,
                  },
                ]),
          ],
          label: "Memory",
          text: limited(
            `${formatBytes(memory.availableBytes)} of ${formatBytes(memory.totalBytes)} available`,
            memory.limited,
          ),
          tone: meterTone(memoryTone),
          ...withPercent(gauges.memory),
        },
    disk === undefined
      ? unavailable("Disk")
      : {
          details: [],
          label: "Disk",
          text: `${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)} free`,
          tone: meterTone(levelOf(gauges.disk)),
          ...withPercent(gauges.disk),
        },
  ];
}

export interface PlatformCard {
  readonly name: string;
  readonly running: number;
  readonly limit: number;
  readonly slots: readonly DeviceSlot[];
  readonly label: string;
}

function platformCards(worker: WorkerView): readonly PlatformCard[] {
  return capacityByPlatform(worker).map((entry) => {
    const slots = platformSlots(worker, entry.platform === "ios" ? "ios" : "android");
    const name = platformName(entry.platform);
    return {
      label: `${name}: ${slotsLabel(slots)}`,
      limit: entry.limit,
      name,
      running: entry.running,
      slots,
    };
  });
}

export interface DeviceRow {
  readonly id: string;
  readonly to: string;
  readonly lease?: { readonly id: string; readonly to: string };
  readonly udid?: string;
  readonly model: string;
  readonly runtime: string;
  readonly platform: string;
  readonly status: Toned;
  readonly holder?: { readonly name: string; readonly id: string; readonly to: string };
  readonly since?: string;
  readonly expires?: string;
  readonly renewed?: string;
  readonly physical: boolean;
  readonly mode?: string;
  readonly imageTag?: string;
}

// why: a worker names a lease by its own id, but a gateway lists it, and opens its page, as
// `<worker id>.<lease id>`; the worker's own id stands where the daemon lists it bare, as a single
// host does.
function leaseIdOnPage(worker: WorkerView, id: string, listed: ReadonlySet<string>): string {
  const qualified = `${worker.id}.${id}`;
  return listed.has(qualified) ? qualified : id;
}

function deviceRow(
  device: WorkerDevice,
  worker: WorkerView,
  now: number,
  tokens: readonly TokenRecord[],
  leaseIds: ReadonlySet<string>,
  search: string,
): DeviceRow {
  const entered = stateEnteredAt(device, worker);
  // why: a virtual device shows its mode only where it is not the one the worker serves by default,
  // and a physical device has neither a mode nor an image.
  const virtual = !device.physical;
  return {
    id: device.id,
    model: device.spec.model,
    physical: device.physical,
    platform: platformName(device.spec.platform),
    runtime: device.spec.osVersion,
    status: deviceStateStatus(device.state),
    to: `${devicePath(worker.id, device.id)}${writeWorkerTab(search, "devices")}`,
    ...leaseFacts(device, worker, now, tokens, leaseIds),
    ...defined({
      udid: device.physical ? device.driverDeviceId : undefined,
      imageTag: virtual ? device.spec.imageTag : undefined,
      mode: virtual && !device.servesDefaultMode ? device.mode : undefined,
      since: entered === undefined ? undefined : formatDuration(now - entered),
    }),
  };
}

function leaseFacts(
  device: WorkerDevice,
  worker: WorkerView,
  now: number,
  tokens: readonly TokenRecord[],
  leaseIds: ReadonlySet<string>,
): Pick<DeviceRow, "expires" | "holder" | "lease" | "renewed"> {
  const lease = worker.leases?.find((candidate) => candidate.deviceId === device.id);
  if (lease === undefined) return {};
  const holder = holderOf(lease.requesterId, tokens);
  const onPage = leaseIdOnPage(worker, lease.id, leaseIds);
  return {
    lease: { id: onPage, to: leasePath(onPage) },
    expires: formatDuration(lease.ttlDeadline - now),
    holder: {
      id: holder.id,
      name: holder.label ?? holder.id,
      to: leasePath(onPage),
    },
    renewed: `${formatDuration(now - lease.lastRenewedAt)} ago`,
  };
}

export interface ProtocolView {
  readonly compatible: boolean;
  readonly ranges?: string;
}

function range({ max, min }: { readonly min: number; readonly max: number }): string {
  return `${min}–${max}`;
}

// why: an incompatible worker names both protocol ranges, so an operator can see which side to
// upgrade.
function protocolOf(worker: WorkerView): ProtocolView {
  const { protocol } = worker;
  if (worker.connection !== "incompatible" && protocol === undefined) return { compatible: true };
  return {
    compatible: false,
    ...(protocol === undefined
      ? {}
      : { ranges: `gateway ${range(protocol.gateway)}, worker ${range(protocol.worker)}` }),
  };
}

export interface OverviewTab {
  readonly starting: boolean;
  readonly incompatible: boolean;
  readonly figures: readonly FigureCard[];
  readonly loadNote?: string;
  readonly read?: string;
  readonly leases?: { readonly count: number; readonly running: number | undefined };
  readonly platforms: readonly PlatformCard[];
  readonly devices?: readonly DeviceRow[];
}

// why: a reading from a worker that is not connected is stale, so it has no figures.
function loadFigures(worker: WorkerView): readonly FigureCard[] {
  return worker.connection === "connected" ? figureCards(worker) : [];
}

function failureBanner(worker: WorkerView): readonly WorkerBanner[] {
  const failure = worker.lastUpdateFailure;
  if (failure === undefined || failure === null) return [];
  return [
    {
      failure: true,
      text: `Update to ${failure.to} failed (${failure.stage}): ${failure.message}`,
      tone: "error",
    },
  ];
}

function updatingBanner(worker: WorkerView): readonly WorkerBanner[] {
  const { update } = worker;
  if (update === undefined || update === null) return [];
  return [
    {
      text: `Updating to ${update.to} · ${stageLine(update)}. It takes no new leases.`,
      tone: "warn",
    },
  ];
}

// why: a worker that is gone, failed to update, updates or is drained is the first thing an operator
// should read on its page, so it says so above everything else, in that order.
function bannersOf(worker: WorkerView, now: number): readonly WorkerBanner[] {
  return [
    ...(worker.connection === "disconnected"
      ? [
          {
            text: `Disconnected · last seen ${formatDuration(now - worker.lastSeenAt)} ago`,
            tone: "warn" as const,
          },
        ]
      : []),
    ...failureBanner(worker),
    ...updatingBanner(worker),
    ...(worker.drained ? [{ text: "Drained", tone: "warn" as const }] : []),
  ];
}

function loadOf(
  worker: WorkerView,
  now: number,
): Pick<OverviewTab, "figures" | "loadNote" | "read"> {
  if (worker.connection === "incompatible") return { figures: [] };
  if (worker.connection === "disconnected") {
    return { figures: [], loadNote: "No reading while disconnected" };
  }
  if (worker.load === undefined) return { figures: [], loadNote: "Not reported" };
  const age = formatDuration(Math.ceil((now - worker.load.readAt) / 1000) * 1000);
  return { figures: figureCards(worker), read: `${age} ago` };
}

export interface CapabilityRow {
  readonly name: string;
  readonly state: string;
  readonly tone: Tone;
  readonly reason?: string;
}

const CAPABILITY_TONE = { available: "ok", off: "idle", unavailable: "warn" } as const;

export interface ToolRow {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly platform: string;
}

export interface CatalogRow {
  readonly platform: string;
  readonly models: string;
  readonly runtimes: string;
}

export interface HostTab {
  readonly id: string;
  readonly version?: string;
  readonly connection: Toned;
  readonly drained: boolean;
  readonly health?: Toned;
  readonly host?: {
    readonly os: string;
    readonly arch: string;
    readonly tools: readonly ToolRow[];
  };
  readonly protocol: ProtocolView;
  readonly capabilities?: readonly CapabilityRow[] | "not-reported";
  readonly catalog: readonly CatalogRow[];
}

function hostTabOf(worker: WorkerView): HostTab {
  const { capabilities, host } = worker;
  // why: a starting worker has reported no capabilities yet, so its list leaves the row out where
  // "Not reported" would suggest a worker that cannot report them.
  const capabilityRows: HostTab["capabilities"] =
    worker.health === "starting"
      ? undefined
      : (capabilities?.map((entry) => ({
          name: entry.name,
          state: entry.state,
          tone: CAPABILITY_TONE[entry.state],
          ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        })) ?? "not-reported");
  return {
    connection: connectionStatus(worker.connection),
    drained: worker.drained,
    catalog: (worker.catalog ?? []).map((entry) => ({
      models: entry.models.length === 0 ? "none" : entry.models.join(", "),
      platform: platformName(entry.platform),
      runtimes:
        entry.runtimes.length === 0
          ? "none"
          : entry.runtimes
              .map((runtime) =>
                runtime === entry.defaultRuntime ? `${runtime} (default)` : runtime,
              )
              .join(", "),
    })),
    id: worker.id,
    protocol: protocolOf(worker),
    ...(worker.version === undefined ? {} : { version: worker.version }),
    ...(worker.health === undefined ? {} : { health: healthStatus(worker.health) }),
    ...(capabilityRows === undefined ? {} : { capabilities: capabilityRows }),
    ...(host === undefined
      ? {}
      : {
          host: {
            arch: host.arch,
            os: `${host.os} ${host.osVersion}`,
            tools: host.tools.map((tool) => ({
              key: `${tool.platform}-${tool.name}`,
              name: tool.name,
              platform: platformName(tool.platform),
              version: `${tool.version}${tool.build === undefined ? "" : ` (${tool.build})`}`,
            })),
          },
        }),
  };
}

export interface WarmRow {
  readonly key: string;
  readonly model: string;
  readonly origin: string;
  readonly runtime: string;
  readonly mode: string;
  readonly wanted: number;
  readonly ready: number;
  readonly booting: number;
  readonly short: string;
}

export interface InstallRow {
  readonly key: string;
  readonly platform: string;
  readonly component: string;
  readonly status: Toned;
  readonly duration: string;
  readonly waiters: string;
}

export interface WarmTab {
  readonly pool?: { readonly enabled: string; readonly reserve: string };
  readonly targets: readonly WarmRow[];
  readonly installs: readonly InstallRow[];
}

function warmRow(row: WarmPoolRow): WarmRow {
  return {
    booting: row.booting,
    key: row.key,
    mode: row.mode,
    model: row.imageTag === undefined ? row.model : `${row.model} / ${row.imageTag}`,
    origin: row.origin,
    ready: row.ready,
    runtime: row.osVersion ?? "—",
    short: row.short ?? "—",
    wanted: row.count,
  };
}

function warmTabOf(worker: WorkerView, now: number): WarmTab {
  const { warmPool } = worker;
  return {
    installs: (worker.installs ?? []).map((install) => ({
      component: install.component,
      duration: formatDuration(now - install.since),
      key: `${install.platform}-${install.component}`,
      platform: platformName(install.platform),
      status: installStatus(install.state),
      waiters: install.waiters === 1 ? "1 waiter" : `${install.waiters} waiters`,
    })),
    targets: warmPool === undefined ? [] : warmPoolRows(warmPool.targets).map(warmRow),
    ...(warmPool === undefined
      ? {}
      : {
          pool: {
            enabled: warmPool.enabled ? "On" : "Off",
            reserve: `iOS ${warmPool.reserveRunning.ios}, Android ${warmPool.reserveRunning.android}`,
          },
        }),
  };
}

export type WorkerTab = "devices" | "warm-pool" | "host" | "events";

// why: the tab lives in the URL as `?tab=`, so a reload or a shared link shows the same tab; a value
// the page does not offer, such as a warm pool on a starting worker, is the Devices tab.
function readWorkerTab(search: string, tabs: readonly { readonly value: WorkerTab }[]): WorkerTab {
  const asked = new URLSearchParams(search).get("tab");
  return tabs.find((tab) => tab.value === asked)?.value ?? "devices";
}

// why: every other key of the query stays, the drawer's paging included.
export function writeWorkerTab(search: string, tab: WorkerTab): string {
  const params = new URLSearchParams(search);
  params.set("tab", tab);
  return `?${params.toString()}`;
}

export interface WorkerBanner {
  readonly text: string;
  readonly tone: "warn" | "error";
  // why: the failure banner offers Update again, when the page's menu offers Update….
  readonly failure?: true;
}

export interface WorkerPage {
  readonly id: string;
  readonly tab: WorkerTab;
  readonly banners: readonly WorkerBanner[];
  readonly title: string;
  readonly connection: WorkerView["connection"];
  readonly drained: boolean;
  readonly mono: boolean;
  readonly health: Toned;
  readonly system?: string;
  readonly version?: string;
  readonly updateFacts: UpdateFacts;
  readonly tabs: readonly { readonly value: WorkerTab; readonly label: string }[];
  readonly overview: OverviewTab;
  readonly host: HostTab;
  readonly warm?: WarmTab;
}

export function workerPageOf(input: {
  readonly worker: WorkerView;
  readonly now: number;
  readonly search?: string;
  readonly tokens: readonly TokenRecord[];
  readonly leaseIds?: readonly string[];
}): WorkerPage {
  const { now, tokens, worker } = input;
  const updateFacts = updateFactsOf(worker);
  const version = versionLine(updateFacts);
  const leaseIds = new Set(input.leaseIds ?? []);
  const starting = worker.health === "starting";
  const incompatible = worker.connection === "incompatible";
  const { host } = worker;
  const leases = worker.leases;
  const tabs: WorkerPage["tabs"] = [
    { label: "Devices", value: "devices" },
    ...(starting ? [] : [{ label: "Warm pool", value: "warm-pool" } as const]),
    { label: "Host", value: "host" },
    { label: "Events", value: "events" },
  ];
  return {
    banners: bannersOf(worker, now),
    connection: worker.connection,
    drained: worker.drained,
    health: workerHealth(worker),
    tab: readWorkerTab(input.search ?? "", tabs),
    host: hostTabOf(worker),
    id: worker.id,
    mono: worker.label === undefined,
    overview: {
      incompatible,
      platforms: starting ? [] : platformCards(worker),
      starting,
      ...loadOf(worker, now),
      ...(starting || leases === undefined
        ? {}
        : { leases: { count: leases.length, running: worker.capacity?.global.running } }),
      ...(starting
        ? {}
        : {
            devices: (worker.devices ?? []).map((d) =>
              deviceRow(d, worker, now, tokens, leaseIds, input.search ?? ""),
            ),
          }),
    },
    tabs,
    title: workerName(worker),
    updateFacts,
    ...(version === undefined ? {} : { version }),
    ...(host === undefined ? {} : { system: `${host.os} ${host.osVersion}` }),
    ...(starting ? {} : { warm: warmTabOf(worker, now) }),
  };
}
