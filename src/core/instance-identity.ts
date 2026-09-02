import { dirname } from "node:path";

import type { Filesystem, IdGenerator } from "../ports/index.js";

export interface InstanceIdentityOptions {
  readonly filesystem: Filesystem;
  readonly idGenerator: IdGenerator;
  /** `${SIMLOCK_HOME}/instance.json`. */
  readonly path: string;
}

export class InstanceIdentityError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "InstanceIdentityError";
  }
}

/**
 * Reads this Simlock installation's identity, generating it exactly once.
 *
 * The identity is what every device root's ownership marker is checked against, so losing
 * it is not a recoverable inconvenience: a regenerated id strands every device already in
 * the root behind `wrong-instance`, with no way back short of deleting tens of gigabytes
 * by hand. That is why an unreadable or malformed file is a hard failure rather than a
 * reason to write a fresh one, and why the id lives here instead of in `state.json` -- a
 * corrupt registry is precisely the situation in which someone rebuilds state, and the
 * identity has to survive that (ADR 0001, decision 2).
 */
export async function loadInstanceId(options: InstanceIdentityOptions): Promise<string> {
  const existing = await readInstanceId(options);
  if (existing !== undefined) {
    return existing;
  }

  await options.filesystem.mkdirp(dirname(options.path));
  await options.filesystem.writeFileAtomic(
    options.path,
    `${JSON.stringify({ instanceId: options.idGenerator.generate() }, null, 2)}\n`,
  );

  // Deliberately re-read rather than return what was just generated. Two daemons starting
  // for the first time at once both write, and only one file survives; trusting the
  // in-memory value would leave the loser marking roots with an id that is not on disk.
  const written = await readInstanceId(options);
  if (written === undefined) {
    throw new InstanceIdentityError(
      `Instance identity vanished immediately after it was written: ${options.path}`,
      options.path,
    );
  }

  return written;
}

/** `undefined` only when the file is genuinely absent -- unreadable is not the same as absent. */
async function readInstanceId(options: InstanceIdentityOptions): Promise<string | undefined> {
  const { filesystem, path } = options;

  if (!(await filesystem.exists(path))) {
    return undefined;
  }

  let contents: string;
  try {
    contents = await filesystem.readFile(path);
  } catch (error: unknown) {
    throw new InstanceIdentityError(
      `Cannot read the instance identity at ${path}: ${describe(error)}`,
      path,
    );
  }

  return parseInstanceId(contents, path);
}

function parseInstanceId(contents: string, path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new InstanceIdentityError(`The instance identity at ${path} is not valid JSON`, path);
  }

  const instanceId =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["instanceId"]
      : undefined;

  if (typeof instanceId !== "string" || instanceId === "") {
    throw new InstanceIdentityError(
      `The instance identity at ${path} has no usable "instanceId"`,
      path,
    );
  }

  return instanceId;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
