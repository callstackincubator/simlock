import type { Logger, ProcessResult, ProcessRunner } from "../ports/index.js";

/** why: ADR 0074 §1: the gateway operator's admission command and how long it may take. */
export interface AdmissionOptions {
  readonly command: readonly string[];
  readonly runner: ProcessRunner;
  readonly timeoutMs: number;
}

/** why: what the command is asked about one request, as one line of JSON on its stdin. */
export interface AdmissionInput {
  readonly requesterId: string;
  readonly principal: string;
  readonly platform: string;
  readonly request: unknown;
  readonly metadata: Record<string, string>;
}

/** why: the command's answer, or why the gateway has none; the coordinator maps each to the caller's error and the event. */
export type AdmissionDecision =
  | { readonly kind: "priority"; readonly priority: number }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "fail"; readonly cause: string };

const NOT_AN_ANSWER = "printed an answer that is not a priority or a refusal";
const PRIORITY_LIMIT = 1000;
const REASON_MAX_LENGTH = 500;
const PROGRAM_MAX_LENGTH = 500;
const STDERR_LOGGED_BYTES = 2048;
const STDOUT_MAX_BYTES = 65_536;

/** why: ADR 0074 §1: a child the runner killed, or a signal that ended it, names its own cause; an exit code is the cause only for a child that exited. */
function causeOf(result: ProcessResult, timeoutMs: number): string | undefined {
  if (result.endedBy === "timeout") return `killed after ${String(timeoutMs)} ms`;
  if (result.endedBy === "output-limit")
    return `printed more than ${String(STDOUT_MAX_BYTES)} bytes`;
  if (result.signal !== undefined) return `killed by signal ${result.signal}`;
  return result.code === 0 ? undefined : `exited ${String(result.code)}`;
}

function fail(cause: string): AdmissionDecision {
  return { cause, kind: "fail" };
}

function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** why: the command is another process: only a priority in range, `{}` or a refusal with a printable reason of 1 to 500 characters is an answer; anything else fails the request. */
function parseAnswer(stdout: string): AdmissionDecision {
  const text = stdout.trim();
  if (text === "") return fail("printed no answer");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(NOT_AN_ANSWER);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(NOT_AN_ANSWER);
  }
  const answer = value as Record<string, unknown>;
  const { deny, priority } = answer;
  if ("deny" in answer && "priority" in answer) return fail(NOT_AN_ANSWER);
  if ("deny" in answer) {
    return typeof deny === "string" &&
      deny.length >= 1 &&
      deny.length <= REASON_MAX_LENGTH &&
      !hasControlCharacter(deny)
      ? { kind: "deny", reason: deny }
      : fail(NOT_AN_ANSWER);
  }
  if (!("priority" in answer)) return { kind: "priority", priority: 0 };
  return typeof priority === "number" &&
    Number.isInteger(priority) &&
    Math.abs(priority) <= PRIORITY_LIMIT
    ? { kind: "priority", priority }
    : fail(NOT_AN_ANSWER);
}

/** why: ADR 0074 §1: the gateway runs the operator's command once per new request and reads its one JSON answer; it fails closed, and its log line names the cause and the start of the command's stderr. */
export async function askAdmission(
  options: AdmissionOptions,
  input: AdmissionInput,
  logger: Logger,
  signal: AbortSignal,
): Promise<AdmissionDecision> {
  const [program = "", ...args] = options.command;
  let decision: AdmissionDecision;
  let stderr = "";
  try {
    const result = await options.runner.run(program, args, {
      input: `${JSON.stringify(input)}\n`,
      maxStdoutBytes: STDOUT_MAX_BYTES,
      signal,
      timeoutMs: options.timeoutMs,
    });
    stderr = result.stderr;
    const cause = causeOf(result, options.timeoutMs);
    decision = cause === undefined ? parseAnswer(result.stdout) : fail(cause);
  } catch {
    decision = fail(`could not start ${program.slice(0, PROGRAM_MAX_LENGTH)}`);
  }
  if (decision.kind === "fail") {
    logger.warn("The admission command could not decide on a request", {
      cause: decision.cause,
      stderr: Buffer.from(stderr).subarray(0, STDERR_LOGGED_BYTES).toString(),
    });
  }
  return decision;
}
