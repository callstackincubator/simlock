import {
  type DriverAdvisory,
  type PassthroughCommand,
  type PassthroughContext,
  PassthroughRefusedError,
  type PhysicalDriverDevice,
  type PhysicalInspection,
  type PresentPhysical,
  type ReclaimResult,
  ScreenUnavailableError,
  uninstallPlan,
} from "../../core/index.js";
import type { ProcessRunner, TcpStreamConnector } from "../../ports/index.js";
import type { ScreenTarget } from "./screen/index.js";
import {
  type AdbGateAnswer,
  DEFAULT_ADB_PORT,
  DefaultAdbServerGate,
  type DefaultAdbServerGateOptions,
} from "./default-adb-server.js";

export const PHYSICAL_RECLAIM_ESTIMATE_MS = 90_000;

const READ_TIMEOUT_MS = 30_000;
const UNINSTALL_TIMEOUT_MS = 60_000;
const PORT = String(DEFAULT_ADB_PORT);

const STRIPPED_ENV_KEYS = ["ANDROID_ADB_SERVER_ADDRESS", "ADB_SERVER_SOCKET", "ANDROID_SERIAL"];

const REFUSED_SUBCOMMANDS = new Set([
  "kill-server",
  "start-server",
  "server",
  "nodaemon",
  "connect",
  "disconnect",
  "pair",
  "reconnect",
  "tcpip",
  "usb",
  "detach",
  "reboot-bootloader",
]);
const REFUSED_REBOOT_TARGETS = new Set([
  "bootloader",
  "sideload",
  "sideload-auto-reboot",
  "recovery",
  "fastboot",
]);

const USER_ID = /^\d{1,6}$/;
const PACKAGE_LINE = /^package:([A-Za-z0-9_.]+)$/;

interface ListedTransport {
  readonly serial: string;
  readonly state: string;
  readonly usb: boolean;
}

type Ran =
  | { readonly kind: "blocked"; readonly answer: Exclude<AdbGateAnswer, { open: true }> }
  | { readonly kind: "failed" }
  | { readonly kind: "ok"; readonly stdout: string };

type Refusal = Extract<PhysicalInspection, { enrollable: false }>;

export class AndroidPhysicalHandler {
  readonly #gate: DefaultAdbServerGate;
  readonly #adb: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #processRunner: ProcessRunner;
  readonly #isBareShell: (args: readonly string[]) => boolean;

  constructor(
    options: Omit<DefaultAdbServerGateOptions, "env"> & {
      readonly baseEnv: NodeJS.ProcessEnv;
      // why: the driver's own test, so one place decides what the interactive shell is.
      readonly isBareShell: (args: readonly string[]) => boolean;
    },
  ) {
    this.#isBareShell = options.isBareShell;
    this.#adb = options.adb;
    this.#processRunner = options.processRunner;
    const env: NodeJS.ProcessEnv = { ...options.baseEnv };
    for (const key of STRIPPED_ENV_KEYS) delete env[key];
    env.ANDROID_ADB_SERVER_PORT = PORT;
    this.#env = env;
    this.#gate = new DefaultAdbServerGate({ ...options, env });
  }

  /**
   * why: where one phone's scrcpy session runs. Every step passes the same version check every other
   * phone command passes, and only then runs `adb -P 5037` with this handler's environment or opens a
   * raw connection to port 5037, so the capture never names a port or a check.
   */
  screenTargetFor(device: PhysicalDriverDevice, tcp: TcpStreamConnector): ScreenTarget {
    const serial = device.deviceId;
    const checked = async (): Promise<void> => {
      const answer = await this.#gate.check();
      if (!answer.open) throw new ScreenUnavailableError(answer.message);
    };
    return {
      connect: async (timeoutMs) => {
        await checked();
        return await tcp.connect(DEFAULT_ADB_PORT, timeoutMs);
      },
      serial,
      spawn: async (args) => {
        await checked();
        return this.#processRunner.spawn(this.#adb, ["-P", PORT, "-s", serial, ...args], {
          env: this.#env,
        });
      },
      run: async (args, timeoutMs) => {
        await checked();
        return await this.#processRunner.run(this.#adb, ["-P", PORT, "-s", serial, ...args], {
          env: this.#env,
          timeoutMs,
        });
      },
    };
  }

  async advisories(): Promise<readonly DriverAdvisory[]> {
    const answer = await this.#gate.check();
    if (answer.open) return [];
    return [
      { code: "adb-protocol-mismatch", message: `Physical Android devices: ${answer.message}` },
    ];
  }

  async inspectPhysical(id: string): Promise<PhysicalInspection> {
    const listing = await this.#run(["devices", "-l"], READ_TIMEOUT_MS);
    if (listing.kind !== "ok") return this.#refusal(listing, "the device list (adb devices -l)");

    const unusable = unenrollable(
      parseDevices(listing.stdout).filter((entry) => entry.serial === id),
    );
    if (unusable !== undefined) return unusable;
    return this.#readDevice(id);
  }

  async #readDevice(id: string): Promise<PhysicalInspection> {
    const model = await this.#readText(id, ["shell", "getprop", "ro.product.model"]);
    if (model.kind !== "ok")
      return this.#refusal(model.ran, "the model (getprop ro.product.model)");
    const level = await this.#readText(id, ["shell", "getprop", "ro.build.version.sdk"]);
    if (level.kind !== "ok") {
      return this.#refusal(level.ran, "the API level (getprop ro.build.version.sdk)");
    }
    const user = await this.#readUser(id);
    if (user.kind !== "ok") return this.#refusal(user.ran, "the current user id");
    const apps = await this.#readPackages(id, user.value);
    if (apps.kind !== "ok") return this.#refusal(apps.ran, "the user apps (pm list packages -3)");

    return {
      apps: apps.value,
      class: "phone",
      driverDeviceId: id,
      enrollable: true,
      model: model.value,
      osVersion: level.value,
    };
  }

  async listPresentPhysical(enrolledIds: readonly string[]): Promise<readonly PresentPhysical[]> {
    const listing = await this.#run(["devices", "-l"], READ_TIMEOUT_MS);
    const entries = listing.kind === "ok" ? parseDevices(listing.stdout) : [];
    const answers: PresentPhysical[] = [];
    for (const driverDeviceId of enrolledIds) {
      const usb = entries.filter((entry) => entry.serial === driverDeviceId && entry.usb);
      if (usb.some((entry) => entry.state === "device")) {
        const level = await this.#readText(driverDeviceId, [
          "shell",
          "getprop",
          "ro.build.version.sdk",
        ]);
        answers.push(
          level.kind === "ok"
            ? { driverDeviceId, osVersion: level.value, present: true }
            : { driverDeviceId, present: false, reason: "not-present" },
        );
      } else if (usb.some((entry) => entry.state === "unauthorized")) {
        answers.push({ driverDeviceId, present: false, reason: "untrusted" });
      } else {
        answers.push({ driverDeviceId, present: false, reason: "not-present" });
      }
    }
    return answers;
  }

  async reclaim(device: PhysicalDriverDevice): Promise<ReclaimResult> {
    const serial = device.deviceId;
    const user = await this.#readUser(serial);
    if (user.kind !== "ok") throw failure("the current user id", user.ran);
    const before = await this.#readPackages(serial, user.value);
    if (before.kind !== "ok") throw failure("the user apps", before.ran);

    const plan = uninstallPlan(before.value, device.enrolledApps);
    for (const name of plan.uninstall) {
      const ran = await this.#run(
        ["-s", serial, "shell", "pm", "uninstall", "--user", user.value, name],
        UNINSTALL_TIMEOUT_MS,
      );
      if (ran.kind !== "ok" || ran.stdout.trim() !== "Success") {
        throw failure(`the uninstall of ${name}`, ran);
      }
    }

    const after = await this.#readPackages(serial, user.value);
    if (after.kind !== "ok") throw failure("the user apps after the uninstalls", after.ran);
    const left = uninstallPlan(after.value, device.enrolledApps).uninstall;
    if (left.length > 0) {
      throw new Error(`physical reclaim left apps installed: ${left.join(", ")}`);
    }
    return { missingApps: plan.missing, state: "ready", strategy: "uninstall" };
  }

  async passthrough(
    device: PhysicalDriverDevice,
    args: readonly string[],
    context: PassthroughContext | undefined,
  ): Promise<PassthroughCommand> {
    this.#assertProxyable(args, context);
    const answer = await this.#gate.check();
    if (!answer.open) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`adb\` on this device: ${answer.message}`,
      );
    }
    return {
      args: ["-P", PORT, "-s", device.deviceId, ...args],
      command: this.#adb,
      env: { ANDROID_ADB_SERVER_PORT: PORT },
      unsetEnv: STRIPPED_ENV_KEYS,
    };
  }

  #assertProxyable(args: readonly string[], context: PassthroughContext | undefined): void {
    const reason = refusalReason(args, context, this.#isBareShell);
    if (reason !== undefined) {
      throw new PassthroughRefusedError("adb", `Refusing \`adb ${args.join(" ")}\`: ${reason}`);
    }
  }

  #refusal(ran: Ran, read: string): Refusal {
    if (ran.kind === "blocked") {
      return ran.answer.kind === "mismatch"
        ? { enrollable: false, message: ran.answer.message, reason: "not-connected" }
        : { enrollable: false, message: ran.answer.message, reason: "unreadable" };
    }
    return { enrollable: false, message: `could not read ${read}`, reason: "unreadable" };
  }

  async #readText(
    serial: string,
    rest: readonly string[],
  ): Promise<
    { readonly kind: "ok"; readonly value: string } | { readonly kind: "failed"; readonly ran: Ran }
  > {
    const ran = await this.#run(["-s", serial, ...rest], READ_TIMEOUT_MS);
    if (ran.kind !== "ok") return { kind: "failed", ran };
    const value = ran.stdout.trim();
    return value === "" ? { kind: "failed", ran: { kind: "failed" } } : { kind: "ok", value };
  }

  async #readUser(
    serial: string,
  ): Promise<
    { readonly kind: "ok"; readonly value: string } | { readonly kind: "failed"; readonly ran: Ran }
  > {
    const ran = await this.#run(["-s", serial, "shell", "am", "get-current-user"], READ_TIMEOUT_MS);
    if (ran.kind !== "ok") return { kind: "failed", ran };
    const value = ran.stdout.trim();
    return USER_ID.test(value)
      ? { kind: "ok", value }
      : { kind: "failed", ran: { kind: "failed" } };
  }

  async #readPackages(
    serial: string,
    userId: string,
  ): Promise<
    | { readonly kind: "ok"; readonly value: readonly string[] }
    | { readonly kind: "failed"; readonly ran: Ran }
  > {
    const ran = await this.#run(
      ["-s", serial, "shell", "pm", "list", "packages", "-3", "--user", userId],
      READ_TIMEOUT_MS,
    );
    if (ran.kind !== "ok") return { kind: "failed", ran };
    const names: string[] = [];
    for (const raw of ran.stdout.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") continue;
      const matched = PACKAGE_LINE.exec(line);
      if (matched?.[1] === undefined) return { kind: "failed", ran: { kind: "failed" } };
      names.push(matched[1]);
    }
    return { kind: "ok", value: names };
  }

  async #run(rest: readonly string[], timeoutMs: number): Promise<Ran> {
    const answer = await this.#gate.check();
    if (!answer.open) return { answer, kind: "blocked" };
    try {
      const result = await this.#processRunner.run(this.#adb, ["-P", PORT, ...rest], {
        env: this.#env,
        timeoutMs,
      });
      return result.code === 0 ? { kind: "ok", stdout: result.stdout } : { kind: "failed" };
    } catch {
      return { kind: "failed" };
    }
  }
}

function failure(read: string, ran: Ran): Error {
  return ran.kind === "blocked"
    ? new Error(`physical reclaim stopped: ${ran.answer.message}`)
    : new Error(`physical reclaim could not read ${read}`);
}

function parseDevices(output: string): ListedTransport[] {
  const entries: ListedTransport[] = [];
  for (const line of output.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const [serial, state] = tokens;
    if (serial === undefined || state === undefined) continue;
    entries.push({ serial, state, usb: tokens.some((token) => token.startsWith("usb:")) });
  }
  return entries;
}

function unenrollable(matching: readonly ListedTransport[]): Refusal | undefined {
  const usb = matching.filter((entry) => entry.usb);
  if (usb.some((entry) => entry.state === "device")) return undefined;
  if (usb.some((entry) => entry.state === "unauthorized")) {
    return {
      enrollable: false,
      message: "USB debugging is not authorized for this host on the device",
      reason: "untrusted",
    };
  }
  if (usb.length === 0 && matching.length > 0) {
    return {
      enrollable: false,
      message: "only USB-connected devices can be enrolled",
      reason: "network-only",
    };
  }
  return {
    enrollable: false,
    message: `the device is not connected to the adb server on port ${PORT}`,
    reason: "not-connected",
  };
}

function refusalReason(
  args: readonly string[],
  context: PassthroughContext | undefined,
  isBareShell: (args: readonly string[]) => boolean,
): string | undefined {
  const [subcommand = "", target = ""] = args;
  if (subcommand.startsWith("-")) {
    return "Simlock supplies the scope, so the command stays aimed at the leased phone.";
  }
  if (REFUSED_SUBCOMMANDS.has(subcommand)) {
    return "it would stop, start or move a server or transport that other holders share, or take the phone off USB for the next holder.";
  }
  if (subcommand === "reboot" && REFUSED_REBOOT_TARGETS.has(target)) {
    return "it takes the phone off adb.";
  }
  if (context?.hasTerminal === false && isBareShell(args)) {
    return "an interactive shell needs a terminal, and this one runs with none. Pass the command to run.";
  }
  return undefined;
}
