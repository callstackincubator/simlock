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
  const generated = options.idGenerator.generate();

  try {
    // An exclusive create, never a plain write: checking that the file is absent and then
    // writing it is a race two daemons starting at once do lose. The loser's write would
    // land on top of an identity the winner had already stamped into its roots, and every
    // one of them would read `wrong-instance` from then on. Here the kernel picks the
    // winner and the loser is told so.
    await options.filesystem.writeFileExclusive(options.path, serializeIdentity(generated));
  } catch (error: unknown) {
    if (!isExistingPathError(error)) {
      throw new InstanceIdentityError(
        `Cannot write the instance identity to ${options.path}: ${describe(error)}`,
        options.path,
      );
    }

    return requireWritten(options);
  }

  return generated;
}

/** The identity another process wrote first: this one adopts it rather than competing. */
async function requireWritten(options: InstanceIdentityOptions): Promise<string> {
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

  let contents: string;
  try {
    contents = await filesystem.readFile(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }

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

function serializeIdentity(instanceId: string): string {
  return `${JSON.stringify({ instanceId }, null, 2)}\n`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExistingPathError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
