import { findCatalogModel } from "../../core/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import type { TokenIdentity } from "../../http/token-store.js";
import { failure, refusal, type FrontReply } from "../shared/replies.js";
import { isKnownRpcMethod } from "../shared/routes.js";
import { commandLeaseId, methodName, type RpcRead } from "../shared/rpc.js";
import {
  addressField,
  asRecord,
  commandName,
  deviceList,
  malformedField,
  normalizeDeviceName,
  present,
  type Fields,
} from "../shared/selectors.js";
import type { FrontContext } from "./context.js";
import { LeaseCheckFailed, tokenDevices, type TokenDevice } from "./token-devices.js";

type RpcRequest = Extract<RpcRead, { kind: "request" }>;

type RulesOutcome =
  | { readonly kind: "accepted"; readonly read: RpcRequest }
  | { readonly kind: "refused"; readonly reply: FrontReply };

const SIMLOCK_PICKS = "refused: simlock picks the device";
const ONLY_IOS_AND_ANDROID = "refused: only iOS and Android";
const UPLOAD_ONLY = "refused: send the app from your machine as an upload";
const NO_DEVICE_LEASED = "refused: no device leased; run open first";
const NAME_THE_DEVICE = "refused: name the device with --udid <id>; run devices to see yours";
const PLATFORMS = ["ios", "android"];

class Refused extends Error {
  constructor(readonly reply: FrontReply) {
    super(reply.message);
  }
}

const refuse = (message: string): Refused => new Refused(refusal(message));

interface Unit {
  readonly kind: "command" | "allocate" | "install";
  readonly owner: Fields;
  readonly command: string;
  readonly isStep: boolean;
}

interface Check {
  readonly context: FrontContext;
  readonly identity: TokenIdentity;
  readonly platforms: readonly string[];
  readonly leaseId: string | undefined;
  readonly leased: TokenDevice | undefined;
  readonly meta: Fields;
  tokenDevices(): Promise<readonly TokenDevice[]>;
  changed: boolean;
}

const isFlat = (unit: Unit): boolean => unit.kind !== "command";

function places(unit: Unit, withRuntime = false): Fields[] {
  if (isFlat(unit)) return [unit.owner];
  const keys = withRuntime ? ["flags", "input", "runtime"] : ["flags", "input"];
  return keys.map((key) => asRecord(unit.owner[key])).filter((place) => place !== undefined);
}

function flagsOf(unit: Unit): Fields {
  if (isFlat(unit)) return unit.owner;
  const existing = asRecord(unit.owner["flags"]);
  if (existing !== undefined) return existing;
  const created: Fields = {};
  unit.owner["flags"] = created;
  return created;
}

function firstString(sources: readonly Fields[], field: string): string | undefined {
  for (const source of sources) {
    const value = source[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function stepsOf(unit: Unit): Unit[] {
  if (unit.command !== "batch") return [];
  const steps = asRecord(unit.owner["flags"])?.["batchSteps"];
  if (!present(steps)) return [];
  if (!Array.isArray(steps)) throw refuse("refused: malformed batchSteps");
  return steps.flatMap((step: unknown): Unit[] => {
    const owner = asRecord(step);
    if (owner === undefined) throw refuse("refused: malformed batchSteps");
    if (present(owner["command"]) && typeof owner["command"] !== "string") {
      throw refuse("refused: malformed command");
    }
    const inner: Unit = {
      command: commandName(owner["command"]),
      isStep: true,
      kind: "command",
      owner,
    };
    return [inner, ...stepsOf(inner)];
  });
}

function checkTypes(unit: Unit): void {
  if (!isFlat(unit)) {
    for (const key of ["flags", "input", "runtime"]) {
      if (present(unit.owner[key]) && asRecord(unit.owner[key]) === undefined) {
        throw refuse(`refused: malformed ${key}`);
      }
    }
  }
  for (const place of places(unit, true)) {
    const field = malformedField(place);
    if (field !== undefined) throw refuse(`refused: malformed ${field}`);
  }
}

function rulePlatform(check: Check, unit: Unit): void {
  for (const place of places(unit, true)) {
    const platform = place["platform"];
    if (!present(platform)) continue;
    if (typeof platform !== "string" || !PLATFORMS.includes(platform)) {
      throw refuse(ONLY_IOS_AND_ANDROID);
    }
    if (!check.platforms.includes(platform)) {
      throw refuse(`refused: ${platform} is not available on this simlock`);
    }
  }
}

function ruleDeviceSet(unit: Unit): void {
  for (const place of places(unit)) {
    if (present(place["iosSimulatorDeviceSet"])) {
      throw refuse(
        "refused: simlock chooses the device set; run disconnect, then connect proxy without --ios-simulator-device-set",
      );
    }
    if (present(place["androidDeviceAllowlist"])) {
      throw refuse(
        "refused: simlock chooses the devices; run disconnect, then connect proxy without --android-device-allowlist",
      );
    }
  }
}

async function namesLeasedModel(check: Check, leased: TokenDevice, name: string): Promise<boolean> {
  if (leased.platform === undefined || leased.model === undefined) return false;
  try {
    const { platforms } = await check.context.dispatch(
      "catalog.get",
      { platform: leased.platform },
      buildHttpSession(check.identity),
    );
    const entry = platforms.find((candidate) => candidate.platform === leased.platform);
    const listed = entry === undefined ? undefined : findCatalogModel(entry, name);
    return listed !== undefined && listed.toLowerCase() === leased.model.toLowerCase();
  } catch {
    return false;
  }
}

const namesDevice = (device: TokenDevice, entry: string): boolean =>
  entry === device.address ||
  (device.name !== undefined && normalizeDeviceName(entry) === normalizeDeviceName(device.name));

async function ruleShardList(check: Check, unit: Unit): Promise<void> {
  const entries = places(unit).flatMap((place) => deviceList(place["device"]));
  if (entries.length === 0) return;
  const devices = await check.tokenDevices();
  for (const entry of entries) {
    if (!devices.some((device) => namesDevice(device, entry))) throw refuse(SIMLOCK_PICKS);
  }
}

async function ruleDevice(check: Check, place: Fields): Promise<boolean> {
  const device = place["device"];
  if (!present(device)) return false;
  const leased = check.leased;
  if (leased === undefined) throw refuse(SIMLOCK_PICKS);
  const name = device as string;
  if (namesDevice(leased, name)) return false;
  if (!(await namesLeasedModel(check, leased, name))) throw refuse(SIMLOCK_PICKS);
  delete place["device"];
  check.changed = true;
  return true;
}

function wrongDeviceKey(check: Check, source: Fields): boolean {
  if (check.leaseId === undefined || !present(source["deviceKey"])) return false;
  return check.leased?.deviceKey === undefined || source["deviceKey"] !== check.leased.deviceKey;
}

function ruleAddresses(check: Check, unit: Unit): void {
  const leased = check.leased;
  for (const place of places(unit)) {
    for (const field of ["udid", "serial"]) {
      if (present(place[field]) && place[field] !== leased?.address) throw refuse(SIMLOCK_PICKS);
    }
    if (wrongDeviceKey(check, place)) throw refuse(SIMLOCK_PICKS);
  }
  if (!unit.isStep && wrongDeviceKey(check, check.meta)) throw refuse(SIMLOCK_PICKS);
}

async function ruleSelectors(check: Check, unit: Unit): Promise<void> {
  if (unit.kind === "install") return;
  ruleAddresses(check, unit);
  if (unit.kind === "allocate") return;
  if (unit.command === "test") return ruleShardList(check, unit);
  let rewritten = false;
  for (const place of places(unit)) {
    if (await ruleDevice(check, place)) rewritten = true;
  }
  if (rewritten && check.leased !== undefined) {
    flagsOf(unit)[addressField(check.leased.platform)] = check.leased.address;
  }
}

async function ruleSharding(check: Check, unit: Unit): Promise<void> {
  if (unit.kind !== "command" || unit.command !== "test") return;
  const found = places(unit);
  if (!found.some((place) => present(place["shardAll"]) || present(place["shardSplit"]))) return;
  if (found.some((place) => deviceList(place["device"]).length > 0)) return;
  const platform = firstString(places(unit, true), "platform");
  const target = firstString(found, "target");
  const matching = (await check.tokenDevices()).filter(
    (device) =>
      (platform === undefined || device.platform === platform) &&
      (target === undefined || (device.target ?? "mobile") === target),
  );
  if (matching.length === 0) throw refuse(NO_DEVICE_LEASED);
  for (const place of found) delete place["device"];
  // why: agent-device holds `--device` against the open session by device name, and an id there is a conflict; its shard lookup takes a name too. A name with a comma would split, so that device goes by its id.
  flagsOf(unit)["device"] = matching
    .map((device) =>
      device.name === undefined || device.name.includes(",") ? device.address : device.name,
    )
    .join(",");
  check.changed = true;
}

function ruleInstall(check: Check, unit: Unit): void {
  if (unit.kind !== "command" || (unit.command !== "install" && unit.command !== "reinstall")) {
    return;
  }
  const upload = check.meta["uploadedArtifactId"];
  if (unit.isStep || typeof upload !== "string" || upload.trim() === "") {
    throw refuse(UPLOAD_ONLY);
  }
}

async function ruleLeaseFree(check: Check, unit: Unit): Promise<void> {
  if (unit.kind !== "command" || (unit.command !== "capabilities" && unit.command !== "doctor")) {
    return;
  }
  const found = places(unit);
  if (found.some((place) => ["udid", "serial", "device"].some((key) => present(place[key])))) {
    return;
  }
  let device = check.leased;
  if (device === undefined) {
    const platform = firstString(places(unit, true), "platform");
    const own = (await check.tokenDevices()).filter(
      (candidate) => platform === undefined || candidate.platform === platform,
    );
    if (own.length !== 1) throw refuse(NAME_THE_DEVICE);
    device = own[0];
  }
  if (device === undefined) throw refuse(NAME_THE_DEVICE);
  flagsOf(unit)[addressField(device.platform)] = device.address;
  check.changed = true;
}

async function applyRules(check: Check, unit: Unit): Promise<void> {
  if (unit.isStep) {
    const named = asRecord(unit.owner["flags"])?.["leaseId"];
    if (present(named) && named !== check.leaseId) {
      throw refuse("refused: a batch step cannot name another lease");
    }
  }
  rulePlatform(check, unit);
  if (unit.kind === "install") return;
  ruleDeviceSet(unit);
  await ruleSelectors(check, unit);
  await ruleSharding(check, unit);
  ruleInstall(check, unit);
  if (unit.isStep && unit.command === "devices") throw refuse("refused: run devices on its own");
  await ruleLeaseFree(check, unit);
}

function unitFor(name: string, params: Fields): Unit | undefined {
  if (name === "command") {
    return {
      command: commandName(params["command"]),
      isStep: false,
      kind: "command",
      owner: params,
    };
  }
  if (name === "lease.allocate") {
    return { command: "", isStep: false, kind: "allocate", owner: params };
  }
  if (name === "install_from_source") {
    return { command: "", isStep: false, kind: "install", owner: params };
  }
  return undefined;
}

function buildCheck(
  context: FrontContext,
  identity: TokenIdentity,
  platforms: readonly string[],
  params: Fields,
  kind: Unit["kind"],
): Check {
  const leaseId = kind === "command" ? commandLeaseId(params) : undefined;
  const held = leaseId === undefined ? undefined : context.map.get(leaseId);
  let devices: Promise<readonly TokenDevice[]> | undefined;
  const meta = asRecord(params["meta"]) ?? {};
  return {
    changed: false,
    context,
    identity,
    leaseId,
    leased:
      leaseId !== undefined && held?.identity.requesterId === identity.requesterId
        ? { ...held, leaseId }
        : undefined,
    meta,
    platforms,
    tokenDevices: () => (devices ??= tokenDevices(context, identity)),
  };
}

export async function checkRequest(
  context: FrontContext,
  identity: TokenIdentity,
  read: RpcRequest,
  platforms: readonly string[],
): Promise<RulesOutcome> {
  try {
    return await run(context, identity, read, platforms);
  } catch (error) {
    if (error instanceof Refused) return { kind: "refused", reply: error.reply };
    if (error instanceof LeaseCheckFailed) {
      return { kind: "refused", reply: failure(error.message) };
    }
    throw error;
  }
}

function checkMeta(check: Check): void {
  const key = check.meta["deviceKey"];
  if (present(key) && typeof key !== "string") throw refuse("refused: malformed deviceKey");
}

async function run(
  context: FrontContext,
  identity: TokenIdentity,
  read: RpcRequest,
  platforms: readonly string[],
): Promise<RulesOutcome> {
  if (!isKnownRpcMethod(read.method)) throw refuse(`refused: unknown method ${read.method}`);
  const body = structuredClone(read.body);
  const params = asRecord(body["params"]) ?? {};
  body["params"] = params;
  const main = unitFor(methodName(read.method) ?? "", params);
  if (main === undefined) return { kind: "accepted", read };
  const units = [main, ...stepsOf(main)];
  const check = buildCheck(context, identity, platforms, params, main.kind);
  checkMeta(check);
  for (const unit of units) checkTypes(unit);
  for (const unit of units) await applyRules(check, unit);
  ruleDevicesAnswer(check, main);
  return accepted(read, check, body);
}

function ruleDevicesAnswer(check: Check, main: Unit): void {
  if (main.command === "devices" && Boolean(check.meta["requestProgress"])) {
    throw refuse("refused: devices does not stream through simlock");
  }
}

function accepted(read: RpcRequest, check: Check, body: Fields): RulesOutcome {
  if (!check.changed) return { kind: "accepted", read };
  const params = asRecord(body["params"]) ?? {};
  return { kind: "accepted", read: { ...read, body, params, text: JSON.stringify(body) } };
}
