import type { ProcessRunner } from "../ports/index.js";

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

/** why: ADR 0074 §1: the gateway runs the operator's command once per new request and reads its one JSON answer; it fails closed. */
export async function askAdmission(
  options: AdmissionOptions,
  input: AdmissionInput,
): Promise<AdmissionDecision> {
  const [program = "", ...args] = options.command;
  const result = await options.runner.run(program, args, {
    input: `${JSON.stringify(input)}\n`,
    timeoutMs: options.timeoutMs,
  });
  const answer = JSON.parse(result.stdout) as { deny?: string; priority?: number };
  if (typeof answer.deny === "string") return { kind: "deny", reason: answer.deny };
  return { kind: "priority", priority: answer.priority ?? 0 };
}
