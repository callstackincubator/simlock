import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { Filesystem, IdGenerator, PathDetails } from "../ports/index.js";
import type { Platform } from "./domain.js";

export const OWNED_ROOT_MARKER_FILE = ".simlock-owned.json";

/** Owner-only. Group or other bits on a device root are grounds for refusing it. */
const ROOT_MODE = 0o700;

/**
 * Why a root was refused. These strings are wire-visible: they travel in the
 * `driver.root-rejected` event payload and are listed in `docs/EVENTS.md`, so the
 * vocabulary is fixed and a new one cannot be invented here alone.
 */
export type RootRejectionReason =
  | "not-absolute"
  | "missing-marker"
  | "invalid-marker"
  | "wrong-instance"
  | "symlink"
  | "wrong-owner"
  | "wrong-permissions"
  | "non-empty-unowned-root"
  | "unreadable";

// fallow-ignore-next-line unused-type -- public shape of the on-disk ownership marker.
export interface OwnedRootMarker {
  readonly schemaVersion: 1;
  readonly owner: "simlock";
  readonly instanceId: string;
  readonly platform: Platform;
}

export class OwnedRootError extends Error {
  constructor(
    message: string,
    readonly reason: RootRejectionReason,
    readonly path: string,
    readonly platform: Platform,
  ) {
    super(message);
    this.name = "OwnedRootError";
  }
}

export interface EnsureOwnedRootOptions {
  readonly filesystem: Filesystem;
  /** Names the staging directory a root is assembled in, so two racing daemons never share one. */
  readonly idGenerator: IdGenerator;
  readonly instanceId: string;
  readonly path: string;
  readonly platform: Platform;
  /** `process.getuid?.()`; `undefined` skips the ownership check on platforms without uids. */
  readonly uid?: number;
}

type RootContext = Omit<EnsureOwnedRootOptions, "path"> & { readonly root: string };

/**
 * Establishes that `path` is a device root this Simlock instance owns, creating it when
 * nothing is there, and returns its resolved path.
 *
 * This is the whole of Simlock's structural ownership proof, and it is deliberately
 * platform-agnostic: a driver supplies a path and nothing else. It fails closed in every
 * ambiguous case -- there is no fallback to a default device location and no adoption of
 * a directory Simlock did not create empty itself, because "empty right now" is not proof
 * of "empty when marked" (ADR 0001, decision 2). Every refusal is an `OwnedRootError`,
 * including one that comes out of an unexpected filesystem failure, because the caller
 * skips a single platform on this error and stops the whole daemon on any other.
 */
export async function ensureOwnedRoot(options: EnsureOwnedRootOptions): Promise<string> {
  if (!isAbsolute(options.path)) {
    // `resolve` would make one up: a relative path lands wherever the process that
    // launched the daemon happened to be standing, which for an auto-launched daemon is
    // some agent's working directory rather than a place anyone chose to put tens of
    // gigabytes of device data -- and in CP5 it is what `--purge-orphans` is aimed at.
    // An empty path is not absolute either, so this covers it too.
    throw refusal(
      options.platform,
      options.path,
      "not-absolute",
      "a device root has to be an absolute path, or it names a different directory to every process that reads the configuration",
    );
  }

  const context: RootContext = { ...options, root: resolve(options.path) };

  if (await createRoot(context)) {
    // A root is never trusted on the strength of "we think we just made it": the checks
    // cost one `lstat`, and they close the window in which what was published is not what
    // is about to be used.
    await validateRootDirectory(context);
    return context.root;
  }

  await validateExistingRoot(context);
  return context.root;
}

/**
 * Creates the root with its marker, or reports `false` when something already occupies the
 * path and validation has to decide about it instead.
 *
 * The root is assembled under a sibling staging name and published with a single `rename`,
 * so neither another daemon nor a crash can observe it half-made. Creating it in place
 * would publish an unmarked directory first: every later start would refuse that as
 * `non-empty-unowned-root` -- the temporary file `writeFileAtomic` leaves beside the marker
 * is enough on its own -- and the only repair would be a hand-typed `rm -rf`. Staging is a
 * *sibling* because `rename` is only atomic within one filesystem.
 *
 * One window survives and is accepted: POSIX `rename` replaces an empty directory at the
 * destination, so a directory created by hand in the sliver between the check below and the
 * rename is taken over. That is far narrower than publishing the root in three observable
 * steps, and the alternatives (a Linux-only `renameat2`, or a lock file that becomes its
 * own stale-state problem) are worse.
 */
async function createRoot(context: RootContext): Promise<boolean> {
  const { filesystem, root } = context;

  if ((await pathDetails(context, root, "it")) !== undefined) {
    return false;
  }

  await attempt(context, "its parent directory could not be created", () =>
    filesystem.mkdirp(dirname(root)),
  );

  const staging = stagingPath(root, context.idGenerator);
  try {
    await filesystem.mkdir(staging, { mode: ROOT_MODE });
    // `mkdir`'s mode is a request the process umask can only subtract from: under a
    // restrictive one (`0o277`, say) the root comes back read-only to its own owner and
    // every device written into it afterwards fails. `chmod` is the only way to end at the
    // permissions validation demands of this root on the next start, and it cannot
    // over-open it either, since it sets exactly the owner-only bits.
    await filesystem.chmod(staging, ROOT_MODE);
    await filesystem.writeFileAtomic(markerPath(staging), serializeMarker(context));
  } catch (error: unknown) {
    // Nothing partial may survive anywhere near the real path, so the staging directory
    // goes before the failure is reported.
    await discard(filesystem, staging);
    throw unexpected(context, "it could not be assembled", error);
  }

  try {
    await filesystem.rename(staging, root);
  } catch (error: unknown) {
    await discard(filesystem, staging);

    // Something occupies the path now: another daemon published its root there first, or a
    // directory of the user's appeared. Either way it is an existing root like any other,
    // and validation -- which never creates -- is what decides about it.
    if (isOccupiedPathError(error)) {
      return false;
    }

    throw unexpected(context, "it could not be published", error);
  }

  return true;
}

async function validateExistingRoot(context: RootContext): Promise<void> {
  await validateRootDirectory(context);
  await validateMarker(context);
}

async function validateRootDirectory(context: RootContext): Promise<void> {
  const { root, uid } = context;
  // Only the root itself is read without following links. An *ancestor* symlink is
  // ordinary -- `/tmp` is a link to `/private/tmp` on macOS, and every test home created
  // with `mkdtemp` sits under it -- so comparing `realpath(root)` against `root` would
  // fail closed on perfectly healthy machines. Do not "harden" this into a realpath check.
  const details = await pathDetails(context, root, "it");

  if (details === undefined) {
    // The root existed a moment ago (that is why creation stood down, or the rename that
    // published it succeeded) and is gone now. Creating it here would be the second
    // attempt this function promises never to make.
    throw rejected(context, "missing-marker", "it disappeared while it was being validated");
  }

  if (details.kind === "symlink") {
    throw rejected(context, "symlink", "it is a symlink, so what it really contains is elsewhere");
  }

  if (details.kind !== "directory") {
    // The reason vocabulary is fixed by the docs and has no separate "not a directory"
    // member. This is the closest true statement it can make: something Simlock did not
    // create is sitting where the root belongs.
    throw rejected(context, "non-empty-unowned-root", "it is not a directory");
  }

  if (uid !== undefined && details.uid !== uid) {
    throw rejected(context, "wrong-owner", `it is owned by uid ${details.uid}, not ${uid}`);
  }

  if ((details.mode & 0o077) !== 0) {
    throw rejected(
      context,
      "wrong-permissions",
      `its permissions are ${formatMode(details.mode)}, which grants access beyond its owner`,
    );
  }
}

async function validateMarker(context: RootContext): Promise<void> {
  const { instanceId, root } = context;
  const path = markerPath(root);
  const details = await pathDetails(context, path, `its ${OWNED_ROOT_MARKER_FILE} marker`);

  if (details === undefined) {
    throw await missingMarkerRejection(context);
  }

  if (details.kind === "symlink") {
    throw rejected(context, "symlink", `its ${OWNED_ROOT_MARKER_FILE} marker is a symlink`);
  }

  const marker = await readMarker(context, path);
  if (marker === undefined) {
    throw rejected(context, "invalid-marker", `its ${OWNED_ROOT_MARKER_FILE} marker is unusable`);
  }

  if (marker.instanceId !== instanceId) {
    throw rejected(
      context,
      "wrong-instance",
      `it belongs to Simlock instance ${marker.instanceId}, not ${instanceId}`,
    );
  }
}

/**
 * An unmarked root is refused either way; the two reasons differ only in what they tell
 * the user. An empty one is most likely a path they created for Simlock by hand, and the
 * fix is to remove it and let Simlock create it. A populated one holds someone's data.
 */
async function missingMarkerRejection(context: RootContext): Promise<OwnedRootError> {
  const entries = await attempt(context, "its contents could not be listed", () =>
    context.filesystem.readdir(context.root),
  );

  return entries.length > 0
    ? rejected(
        context,
        "non-empty-unowned-root",
        `it holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"} and carries no ${OWNED_ROOT_MARKER_FILE} marker`,
      )
    : rejected(
        context,
        "missing-marker",
        `it carries no ${OWNED_ROOT_MARKER_FILE} marker, and Simlock only marks a root it created itself`,
      );
}

/** `undefined` for anything that is not this instance's marker shape -- see `invalid-marker`. */
async function readMarker(
  context: RootContext,
  path: string,
): Promise<OwnedRootMarker | undefined> {
  // A marker that cannot be read and one that cannot be parsed are the same answer: this
  // is not a root whose ownership Simlock can vouch for. This catch stays narrow on
  // purpose -- widening it to `unreadable` would demote a deliberate refusal to a
  // filesystem accident.
  let parsed: unknown;
  try {
    parsed = JSON.parse(await context.filesystem.readFile(path)) as unknown;
  } catch {
    return undefined;
  }

  return isOwnedRootMarker(parsed, context.platform) ? parsed : undefined;
}

/**
 * The platform is part of the identity check, not just of the payload: swapping the iOS
 * and Android roots in config would otherwise hand each driver the other's devices.
 */
function isOwnedRootMarker(value: unknown, platform: Platform): value is OwnedRootMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const marker = value as Record<string, unknown>;

  return (
    marker["schemaVersion"] === 1 &&
    marker["owner"] === "simlock" &&
    marker["platform"] === platform &&
    typeof marker["instanceId"] === "string" &&
    marker["instanceId"] !== ""
  );
}

function serializeMarker(context: RootContext): string {
  const marker: OwnedRootMarker = {
    schemaVersion: 1,
    owner: "simlock",
    instanceId: context.instanceId,
    platform: context.platform,
  };

  return `${JSON.stringify(marker, null, 2)}\n`;
}

function markerPath(root: string): string {
  return join(root, OWNED_ROOT_MARKER_FILE);
}

/**
 * Hidden, and unique to this attempt: two daemons racing to create one root must not land
 * on the same staging directory, or the loser's cleanup would delete the winner's work
 * mid-flight. The uniqueness comes from the injected generator rather than an ambient
 * `randomUUID`, because this is core code and rule 9 admits no exception for entropy.
 */
function stagingPath(root: string, idGenerator: IdGenerator): string {
  return join(dirname(root), `.${basename(root)}.${idGenerator.generate()}.staging`);
}

/** Best effort: the failure that brought us here is the one worth reporting. */
async function discard(filesystem: Filesystem, path: string): Promise<void> {
  try {
    await filesystem.rm(path);
  } catch {
    // A staging directory left behind is untidy and harmless -- it is not the root, and
    // its name says what it is. Reporting the cleanup's failure instead of the one that
    // caused it would hide the thing worth fixing.
  }
}

/** `undefined` for a path that is absent; anything else that goes wrong is `unreadable`. */
async function pathDetails(
  context: RootContext,
  path: string,
  subject: string,
): Promise<PathDetails | undefined> {
  try {
    return await context.filesystem.lstat(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw unexpected(context, `${subject} could not be read`, error);
  }
}

async function attempt<T>(
  context: RootContext,
  explanation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    throw unexpected(context, explanation, error);
  }
}

/**
 * A filesystem failure the validator has no answer for is still a refused root, never a
 * raw errno escaping to the caller: the daemon skips one platform on an `OwnedRootError`
 * and dies on anything else, so a mistyped `deviceRoot` whose parent is a file (`ENOTDIR`)
 * would otherwise take down every driver instead of one (safety rule 9).
 */
function unexpected(context: RootContext, explanation: string, error: unknown): OwnedRootError {
  return rejected(context, "unreadable", `${explanation}: ${describeError(error)}`);
}

function rejected(
  context: RootContext,
  reason: RootRejectionReason,
  explanation: string,
): OwnedRootError {
  return refusal(context.platform, context.root, reason, explanation);
}

function refusal(
  platform: Platform,
  path: string,
  reason: RootRejectionReason,
  explanation: string,
): OwnedRootError {
  return new OwnedRootError(
    `Refusing the ${platform} device root ${path}: ${explanation}`,
    reason,
    path,
    platform,
  );
}

/** The errno matters as much as the message: it is what tells a user what to go and fix. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);

  return typeof code === "string" ? `${message} (${code})` : message;
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/**
 * `rename` reports an occupied destination three ways depending on the kernel and on what
 * is sitting there: a non-empty directory, a directory replaced by a file, or a plain
 * refusal to clobber.
 */
function isOccupiedPathError(error: unknown): boolean {
  const code = errorCode(error);

  return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
