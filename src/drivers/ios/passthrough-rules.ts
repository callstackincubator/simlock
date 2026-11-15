import {
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
  isPhysicalDriverDevice,
  type PassthroughCommand,
  type PassthroughContext,
  PassthroughRefusedError,
} from "../../core/index.js";
import { devicectlExecCommand } from "./devicectl-exec.js";
import { fillSimctlDevice } from "./simctl-device.js";

/**
 * why: a driver that refused to start has no instance to ask, so the `simlock <tool>` names
 * it answers to are a constant, and `DriverRejection` carries them so `simlock simctl` can
 * say why it is unavailable rather than reading as a missing SDK.
 */
export const IOS_PASSTHROUGH_TOOLS: readonly string[] = ["simctl", "devicectl"];

/**
 * why: Verbs `simlock simctl` will not proxy. Every one of them changes a device's lifecycle,
 * which the registry -- not `simctl` -- is the record of: a device created here has no
 * registry entry and reads as an orphan, and one erased or deleted under a live lease
 * reads as tampering on the next reconcile. Injecting `--set` for them would hand back
 * exactly the capability the device set exists to take away (ADR 0001, decision 7).
 */
export const REFUSED_SIMCTL_VERBS = new Set(["create", "erase", "delete"]);

export const CALLER_SUPPLIED_SCOPE_FLAGS = new Set(["set", "profiles"]);

export const SHUTDOWN_ALL_TARGET = "all";

export const REFUSED_RUNTIME_OPERATION = "delete";

const RECLAIM_INSTEAD =
  "Use `simlock release` (which deletes the device for you) or `simlock cleanup` instead.";

export async function passthroughCommand(
  tool: string,
  device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
  args: readonly string[],
  context: PassthroughContext | undefined,
  scopedArgv: (args: readonly string[]) => string[],
): Promise<PassthroughCommand> {
  if (tool === "devicectl") return devicectlPassthrough(device, args, context);
  if (tool !== "simctl") {
    throw new PassthroughRefusedError(
      tool,
      `Refusing \`${tool}\`: the iOS driver does not wrap it.`,
    );
  }
  if (context?.platform !== undefined && context.platform !== "ios") {
    throw new PassthroughRefusedError(
      tool,
      `Refusing \`simctl\`: it only serves an iOS simulator, and this lease is on the ${context.platform} platform.`,
    );
  }
  if (device !== undefined && isPhysicalDriverDevice(device)) {
    throw new PassthroughRefusedError(
      tool,
      "Refusing `simctl`: it serves simulators, and this lease holds a physical device. Use `devicectl`.",
    );
  }
  assertProxyable(args);
  const scopedArgs = device === undefined ? args : fillSimctlDevice(args, device.deviceId);
  // why: No environment: simctl ignores every variable that could carry the device set.
  return await Promise.resolve({
    args: scopedArgv(scopedArgs),
    command: "xcrun",
    env: {},
  });
}

function devicectlPassthrough(
  device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
  args: readonly string[],
  context: PassthroughContext | undefined,
): PassthroughCommand {
  const tool = "devicectl";
  if (device === undefined) {
    throw new PassthroughRefusedError(
      tool,
      "Refusing `simlock devicectl`: Simlock has no local devicectl wrapper. Run `xcrun devicectl` directly, or use `device.exec` on a lease.",
    );
  }
  if (context?.platform !== undefined && context.platform !== "ios") {
    throw new PassthroughRefusedError(
      tool,
      `Refusing \`devicectl\`: it only serves a physical iOS device, and this lease is on the ${context.platform} platform.`,
    );
  }
  if (!isPhysicalDriverDevice(device)) {
    throw new PassthroughRefusedError(
      tool,
      "Refusing `devicectl`: it only serves a physical device, and this lease holds a simulator. Use `simctl`.",
    );
  }
  return devicectlExecCommand(device.deviceId, args);
}

function assertProxyable(args: readonly string[]): void {
  const [verb, ...operands] = subcommand(args);
  if (verb === undefined) return;
  if (REFUSED_SIMCTL_VERBS.has(verb)) {
    refuse(
      verb,
      `it changes a device's lifecycle behind Simlock's registry, which would report the device as drifted on the next reconcile. ${RECLAIM_INSTEAD}`,
    );
  }
  if (verb === "shutdown" && operands.includes(SHUTDOWN_ALL_TARGET)) {
    refuse(
      `shutdown ${SHUTDOWN_ALL_TARGET}`,
      `it stops every device in Simlock's set at once -- every agent's, not just yours -- and each interrupted lease spends its recovery budget rebooting, so one that runs out ends as \`lease_lost\`. Shutting a single device down by udid is still allowed. ${RECLAIM_INSTEAD}`,
    );
  }
  // why: A bare `simctl` reaches this too, so refusing it takes no capability away. The
  // wrapper is advertised as the safe path, and being the convenient route to a
  // multi-gigabyte deletion of a runtime Xcode shares is not that.
  if (
    verb === "runtime" &&
    operands.find((operand) => !operand.startsWith("-")) === REFUSED_RUNTIME_OPERATION
  ) {
    refuse(
      `runtime ${REFUSED_RUNTIME_OPERATION}`,
      "it deletes a runtime shared with Xcode and other tools. To remove a runtime Simlock added, use `simlock component remove ios <version>`; delete any other through Xcode.",
    );
  }
}

function refuse(command: string, guidance: string): never {
  throw new PassthroughRefusedError(
    "simctl",
    `Refusing \`simlock simctl ${command}\`: ${guidance}`,
  );
}

function subcommand(args: readonly string[]): readonly string[] {
  for (const [index, argument] of args.entries()) {
    if (!argument.startsWith("-")) return args.slice(index);
    const flag = /^-+([^=]*)/.exec(argument)?.[1];
    if (flag !== undefined && CALLER_SUPPLIED_SCOPE_FLAGS.has(flag)) {
      throw new PassthroughRefusedError(
        "simctl",
        `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and a caller-supplied \`--${flag}\` would point simctl somewhere Simlock does not manage. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
      );
    }
    // why: Not `--set`/`--profiles` by name, but simctl has no other legitimate global here --
    // refused on sight rather than skipped over as presumed harmless, the same way an
    // unrecognized adb global is (`allowedGlobalArity`). Skipping it is exactly what let a
    // caller-supplied `--set`/`--profiles` hide behind an unrecognized flag's *value*.
    throw new PassthroughRefusedError(
      "simctl",
      `Refusing \`simlock simctl ${argument}\`: \`simlock simctl\` supplies the device set itself, and does not recognize any caller-supplied argument ahead of the subcommand. Drop the flag -- the command is already scoped -- or run \`xcrun simctl\` directly if you mean to leave Simlock's set.`,
    );
  }
  return [];
}
