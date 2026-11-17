import {
  type PassthroughCommand,
  type PassthroughContext,
  PassthroughRefusedError,
  type PhysicalDriverDevice,
  type VirtualDriverDevice,
  isPhysicalDriverDevice,
} from "../../core/index.js";
import type { ProcessResult, ProcessRunner } from "../../ports/index.js";
import { otherDeviceRefusal } from "../other-device-refusal.js";
import type { AdbTools } from "./adb-tools.js";

/**
 * why: the `simlock <tool>` wrappers this driver answers to are a constant because a
 * driver that refused to start has no instance to ask, and `DriverRejection` carries the
 * names so `simlock adb` can say why it is unavailable rather than reading as a missing SDK.
 */
export const ANDROID_PASSTHROUGH_TOOLS: readonly string[] = ["adb"];

const RECLAIM_INSTEAD =
  "Use `simlock release` (which deletes the device for you) or `simlock cleanup` instead.";

/**
 * why: `kill-server` would detach every leased emulator at once -- an agent's most reflexive
 * troubleshooting step. Matched anywhere in the arguments rather than in first position:
 * `adb -P 1 kill-server` is the same command with a global in front of it, and a
 * positional scan is the only rule that catches every spelling without this module having
 * to parse adb's own option grammar.
 */
export const REFUSED_ADB_VERB = "kill-server";

/**
 * why: #1168. `adb disconnect` with no address makes the server kick every local transport,
 * which emulators are, and with an address it kicks that one: either way it detaches a lease
 * other than the caller's. Unlike `kill-server` it is refused only as the subcommand, so
 * `adb shell echo disconnect` still runs.
 */
const REFUSED_ADB_SUBCOMMAND = "disconnect";

/**
 * why: Console commands `simlock adb` will not proxy, matched as a run of adjacent arguments
 * anywhere in the list so that `-s <serial> emu kill` is caught along with `emu kill`.
 * Every one of them reaches through Simlock's own adb server, which is the only server
 * that can see these emulators at all -- a bare `adb` cannot, so what is refused here is
 * genuinely a capability, and it is refused because it mutates a device behind the
 * registry's back (ADR 0001, decision 7).
 */
const STOPS_A_RUNNING_DEVICE =
  "it stops a device Simlock still believes is running, which reports as drift on the next reconcile.";

/**
 * adb globals `simlock adb` passes a caller's command through unchanged. This is an
 * **allow list**, not a blocklist of the flags known to point `adb` at a different server
 * than the one Simlock owns (`-P`/`-H`/`-L`/`--server-port`, which adb takes the **last** of
 * on the line, so a caller-supplied one would silently win over the one this driver inserts
 * and land the command on the machine's default server, outside containment entirely --
 * safety rule 9, the same hole the iOS driver closes by refusing a caller-supplied
 * `--set`/`--profiles`).
 *
 * A blocklist only refuses what someone already thought to name, and adb has globals this
 * list never needed to: `--reply-fd` takes a value, is absent from `adb --help`, and is real
 * -- confirmed against the adb binary on this machine (1.0.41 / 37.0.1), which errors
 * `--reply-fd requires an argument` rather than `unknown command`. A scanner that assumes an
 * unrecognized flag takes no value treats `--reply-fd 9` as ending the globals region at `9`,
 * and never sees the `-H`/`-P` that follow it -- exactly the bypass this allow list closes.
 * Root validation fails closed (safety rule 9): an argument here whose arity this driver does
 * not know is refused, not assumed harmless.
 *
 * Only `-s`, `-t`, `-d`, `-e` are allowed through: they select which device on Simlock's own
 * server a command talks to, which is what arguments before the subcommand are *for*, and
 * refusing them would break every multi-device invocation to prevent nothing, since every
 * device they can name is one Simlock already manages. What that does mean -- any lease
 * holder can name any Simlock device on this machine -- is the accident boundary ADR 0001
 * draws, not a hole in this list; see https://github.com/callstackincubator/simlock/blob/main/src/drivers/AGENTS.md. Everything else -- the known
 * scope flags, `-a`, `--exit-on-write-error`, `--one-device`, `--reply-fd`, and any global a
 * future adb adds -- is refused in this position, whether or not it turns out to be benign.
 *
 * Arity, verified against real adb on this machine: `-d` and `-e` take no value. `-s` is
 * **separate-only** -- adb rejects the fused `-sSERIAL` outright (`-s requires an argument`).
 * `-t` accepts both `-t 123` and the fused `-t123` (`strncmp(argv[0], "-t", 2)`).
 *
 * `--version` and `--help` are also allowed through, but not as globals with an arity: adb
 * answers them on their own, before it ever looks for a subcommand (`-h` gets no such
 * treatment and is `unknown command` on real adb), so for this scan they *are* the
 * subcommand rather than something that precedes one -- and only when nothing follows them.
 * adb answers `--version`/`--help` and exits without ever looking at the rest of the line, so
 * this driver has no way to vouch for what comes after one: `["--version", "-P", "5037",
 * "shell", "id"]` is verified against real adb to print the version and exit 0, never reaching
 * the `-P`/`shell` that follow, but a scan that let them ride along on the strength of
 * `--version` ending it would wave through exactly the kind of unvetted tail this allow list
 * exists to refuse everywhere else.
 */
const SELF_CONTAINED_ACTIONS: readonly string[] = ["--version", "--help"];

function allowedGlobalArity(argument: string): "none" | "value" | undefined {
  if (argument === "-d" || argument === "-e") return "none";
  if (argument === "-s") return "value";
  if (argument === "-t") return "value";
  if (argument.startsWith("-t") && argument.length > 2) return "none";
  return undefined;
}

type GlobalsWalkResult =
  | { readonly kind: "subcommand"; readonly index: number }
  | { readonly kind: "refused"; readonly argument: string }
  | { readonly kind: "none" };

/**
 * why: Walks adb's globals grammar (`allowedGlobalArity`) up to the subcommand, the one place both
 * `callerSuppliedScopeFlag` and `isBareShell` need to agree on where the globals region ends
 * and the subcommand's own operands begin -- `adb shell echo -Please` is a word to echo, not
 * an attempt to move the server, and `adb shell input text shell` is a command with `shell` as
 * an *operand*, not the bare interactive shell `isBareShell` refuses without a terminal. Same
 * scan the iOS driver runs for `--set`/`--profiles`, for the same reason, except this one
 * refuses by *not* recognizing a flag rather than by recognizing it: see `allowedGlobalArity`.
 */
function walkGlobals(args: readonly string[]): GlobalsWalkResult {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    // why: The first argument that is not a flag is the subcommand, and everything from there on is
    // its own -- unless it is the *value* of a global that takes one (`-s <serial>`), which is
    // why this walks adb's small global grammar rather than stopping at the first bare word.
    if (!argument.startsWith("-")) return { index, kind: "subcommand" };
    // why: Self-contained only when it is the *sole* argument: adb answers it and exits without
    // looking at anything else on the line, so anything after it is a tail this driver never
    // gets to vouch for and must refuse rather than wave through (the hardening note above).
    if (SELF_CONTAINED_ACTIONS.includes(argument)) {
      if (args.length === 1) return { index, kind: "subcommand" };
      return { argument, kind: "refused" };
    }
    const arity = allowedGlobalArity(argument);
    // why: Not one of the four we allow through: refuse rather than guess whether it takes a value
    // (and so whether the *next* argument is really the subcommand or this flag's operand).
    if (arity === undefined) return { argument, kind: "refused" };
    if (arity === "value") index += 1;
  }
  return { kind: "none" };
}

/**
 * why: ADR 0047 §1. `adb help` (platform-tools 37.0.0): these subcommands act on no device, so
 * a `-s` in front of them would be noise. `forward --list` and `reconnect offline` are the
 * two that depend on their operand and are matched in `actsOnNoDevice`.
 */
const NO_DEVICE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "devices",
  "help",
  "version",
  "connect",
  "disconnect",
  "pair",
  "mdns",
  "keygen",
  "start-server",
  "kill-server",
  "--version",
  "--help",
]);

function actsOnNoDevice(args: readonly string[], index: number): boolean {
  const subcommand = args[index] as string;
  if (NO_DEVICE_SUBCOMMANDS.has(subcommand)) return true;
  if (subcommand === "forward") return args[index + 1] === "--list";
  return subcommand === "reconnect" && args[index + 1] === "offline";
}

/** why: Whether the globals before `end` already name `serial` with `-s`; `-t`, `-e`, `-d` and any other serial are refused. */
function namesOwnSerial(args: readonly string[], end: number, serial: string): boolean {
  let named = false;
  for (let index = 0; index < end; index += 1) {
    const flag = args[index] as string;
    const value = flag === "-s" || flag === "-t" ? args[index + 1] : undefined;
    if (flag !== "-s" || value !== serial) {
      throw otherDeviceRefusal(
        "adb",
        args,
        value === undefined ? flag : `${flag} ${value}`,
        serial,
      );
    }
    named = true;
    index += 1;
  }
  return named;
}

/** why: Puts `-s <serial>` in front of the globals unless the subcommand needs no device or the caller already named this one. */
function fillAdbDevice(args: readonly string[], serial: string): readonly string[] {
  const walked = walkGlobals(args);
  if (walked.kind !== "subcommand" || actsOnNoDevice(args, walked.index)) return args;
  return namesOwnSerial(args, walked.index, serial) ? args : ["-s", serial, ...args];
}

function callerSuppliedScopeFlag(args: readonly string[]): string | undefined {
  const walked = walkGlobals(args);
  return walked.kind === "refused" ? walked.argument : undefined;
}

export const REFUSED_ADB_SEQUENCES: readonly {
  readonly sequence: readonly string[];
  /** why: The words that may follow the sequence; any other (or none) is refused. Absent: the sequence alone is refused. */
  readonly allowedNext?: readonly string[];
  readonly reason: string;
}[] = [
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "kill"] },
  { reason: STOPS_A_RUNNING_DEVICE, sequence: ["emu", "avd", "stop"] },
  {
    // why: Not drift, which is why it needs saying: the emulator keeps running and nothing looks
    // wrong. Any console snapshot subcommand (save, push, pull, delete and its `del` alias, load,
    // remap, or one a later emulator adds) can replace or remove the boot snapshot Simlock starts
    // this device from. Only `list` is safe, so the rule is an allowlist of one and not a list of verbs.
    allowedNext: ["list"],
    reason: "it can replace or destroy the boot snapshot Simlock starts this device from.",
    sequence: ["emu", "avd", "snapshot"],
  },
];

/**
 * why: Whether this is `adb shell` with nothing after it -- the interactive shell. Recognised by
 * walking `walkGlobals` to find the actual *subcommand* -- the first argument past any
 * `-s <serial>` / `-P <port>` / other global -- and checking that it is `shell` **and** the
 * last argument, rather than by checking whether the line's last word happens to spell
 * `shell`. The naive check refused `adb shell echo shell`, `adb shell input text shell`, and
 * even `adb push ./x shell` -- every one of them ends in the word `shell` as an *operand*, not
 * as the bare subcommand, so none of them is the interactive shell this refusal exists for
 * (round 4, F2). A line whose globals region this driver refuses (`walkGlobals` returning
 * `"refused"`) or that names no subcommand at all is never the bare shell either -- it is
 * refused by `callerSuppliedScopeFlag`, or has nothing to run in the first place.
 */
function isBareShell(args: readonly string[]): boolean {
  const walked = walkGlobals(args);
  return (
    walked.kind === "subcommand" &&
    args[walked.index] === "shell" &&
    walked.index === args.length - 1
  );
}

/**
 * why: `adb emu` joins its operands with spaces into one emulator console line, so the words the
 * console sees are the operands split on whitespace, not the argv tokens. Matching is
 * case-insensitive (refusing too much is harmless here) and only looks at the operands after the
 * `emu` subcommand: an `adb shell` argument is a device shell command, never a console line.
 */
function containsSequence(
  args: readonly string[],
  sequence: readonly string[],
  allowedNext?: readonly string[],
): boolean {
  const walked = walkGlobals(args);
  if (walked.kind !== "subcommand" || args[walked.index] !== "emu") return false;
  const words = args
    .slice(walked.index + 1)
    .flatMap((argument) => argument.toLowerCase().split(/\s+/))
    .filter((word) => word !== "");
  const consoleWords = sequence.slice(1);
  return words.some((_, index) => {
    if (!consoleWords.every((token, offset) => words[index + offset] === token)) return false;
    if (allowedNext === undefined) return true;
    const next = words[index + consoleWords.length];
    return next === undefined || !allowedNext.includes(next);
  });
}

// why: The refusal text for the first REFUSED_ADB_SEQUENCES entry the arguments contain, or undefined when none is.
function refusedSequenceMessage(args: readonly string[]): string | undefined {
  const refused = REFUSED_ADB_SEQUENCES.find((candidate) =>
    containsSequence(args, candidate.sequence, candidate.allowedNext),
  );
  if (refused === undefined) return undefined;
  const qualifier =
    refused.allowedNext === undefined ? "" : ` (anything but ${refused.allowedNext.join(", ")})`;
  return `Refusing \`simlock adb ${refused.sequence.join(" ")}${qualifier}\`: ${refused.reason} ${RECLAIM_INSTEAD}`;
}

export interface PassthroughRulesOptions {
  readonly adb: string;
  readonly adbServerPort: number;
  readonly adbTools: AdbTools;
  readonly platform: string;
  /** why: a phone's handler is built with this part's `isBareShell`, so the part reaches it through callbacks rather than owning it. */
  readonly physical: {
    readonly passthrough: (
      device: PhysicalDriverDevice,
      args: readonly string[],
      context?: PassthroughContext,
    ) => Promise<PassthroughCommand>;
    readonly runAdb: (
      device: PhysicalDriverDevice,
      args: readonly string[],
      timeoutMs: number,
    ) => Promise<ProcessResult>;
  };
  readonly processRunner: ProcessRunner;
}

export class PassthroughRules {
  readonly #options: PassthroughRulesOptions;

  constructor(options: PassthroughRulesOptions) {
    this.#options = options;
  }

  isBareShell(args: readonly string[]): boolean {
    return isBareShell(args);
  }

  /** why: `ANDROID_ADB_SERVER_PORT` rides along so an adb that re-execs itself stays on the same server. */
  async passthrough(
    device: VirtualDriverDevice | PhysicalDriverDevice | undefined,
    args: readonly string[],
    context?: PassthroughContext,
  ): Promise<PassthroughCommand> {
    const options = this.#options;
    if (context?.platform !== undefined && context.platform !== options.platform) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`adb\`: it only serves an Android device, and this lease is on the ${context.platform} platform.`,
      );
    }
    if (device !== undefined && isPhysicalDriverDevice(device)) {
      return options.physical.passthrough(device, args, context);
    }
    this.#assertProxyable(args, context);
    const scopedArgs =
      device === undefined || device.address === "" ? args : fillAdbDevice(args, device.address);
    return await Promise.resolve({
      args: ["-P", String(options.adbServerPort), ...scopedArgs],
      command: options.adb,
      env: { ANDROID_ADB_SERVER_PORT: String(options.adbServerPort) },
    });
  }

  // why: one adb call on a device through the server that owns it: a phone's behind the version check, an emulator's on Simlock's own server.
  async runAdbOn(
    device: VirtualDriverDevice | PhysicalDriverDevice,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<ProcessResult> {
    const options = this.#options;
    if (isPhysicalDriverDevice(device))
      return await options.physical.runAdb(device, args, timeoutMs);
    const { serial } = options.adbTools.dataFor(device);
    if (serial === "") throw new Error("the emulator is not running");
    return await options.processRunner.run(
      options.adb,
      ["-P", String(options.adbServerPort), "-s", serial, ...args],
      { env: options.adbTools.env(), timeoutMs },
    );
  }

  #assertProxyable(args: readonly string[], context?: PassthroughContext): void {
    // why: A shell with nothing to run *is* the interactive shell, and an interactive shell
    // without a terminal is a process that reads a pipe that will never carry anything --
    // it hangs until whatever timeout its caller has. Refused only where there is no
    // terminal (`device.exec`, ADR 0005 §19c); the local `simlock adb shell`, which inherits
    // the CLI's own tty, is untouched and still the way to get one.
    if (context?.hasTerminal === false && isBareShell(args)) {
      throw new PassthroughRefusedError(
        "adb",
        "Refusing `simlock adb shell` with no command: an interactive shell needs a terminal, and this one runs on the device's own machine with none. Pass the command to run (`simlock adb shell getprop`), or run `simlock adb shell` on that machine.",
      );
    }
    if (args.includes(REFUSED_ADB_VERB)) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${REFUSED_ADB_VERB}\`: it would detach every leased emulator at once. Use \`simlock release\` to give a device back, or \`simlock cleanup\` to reclaim idle ones.`,
      );
    }
    const walked = walkGlobals(args);
    if (walked.kind === "subcommand" && args[walked.index] === REFUSED_ADB_SUBCOMMAND) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${REFUSED_ADB_SUBCOMMAND}\`: it would detach other leased emulators, which adb treats as connections it can drop. Use \`simlock release\` to give a device back, or \`simlock cleanup\` to reclaim idle ones.`,
      );
    }
    const refusedSequence = refusedSequenceMessage(args);
    if (refusedSequence !== undefined) throw new PassthroughRefusedError("adb", refusedSequence);

    const scopeFlag = callerSuppliedScopeFlag(args);
    if (scopeFlag !== undefined) {
      throw new PassthroughRefusedError(
        "adb",
        `Refusing \`simlock adb ${scopeFlag}\`: \`simlock adb\` supplies the adb server itself, and only allows \`-s\`/\`-t\`/\`-d\`/\`-e\` ahead of the subcommand -- anything else there, whether it is a known way to move the server or one this driver does not recognize, might point the command at a server that cannot see Simlock's devices, or at one it must not touch. Drop the flag -- the command is already scoped -- or run \`adb\` directly if you mean to leave Simlock's server.`,
      );
    }
  }
}
