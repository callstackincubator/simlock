import { dirname, join, resolve } from "node:path";

import type { Filesystem, PathDetails } from "../ports/index.js";
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
  | "missing-marker"
  | "invalid-marker"
  | "wrong-instance"
  | "symlink"
  | "wrong-owner"
  | "wrong-permissions"
  | "non-empty-unowned-root";

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
 * of "empty when marked" (ADR 0001, decision 2).
 */
export async function ensureOwnedRoot(options: EnsureOwnedRootOptions): Promise<string> {
  const context: RootContext = { ...options, root: resolve(options.path) };

  if (await createRoot(context)) {
    return context.root;
  }

  await validateExistingRoot(context);
  return context.root;
}

/**
 * Creates the root with its marker, or reports `false` when something already occupies the
 * path and validation has to decide about it instead.
 */
async function createRoot(context: RootContext): Promise<boolean> {
  const { filesystem, root } = context;

  if ((await pathDetails(filesystem, root)) !== undefined) {
    return false;
  }

  await filesystem.mkdirp(dirname(root));

  try {
    await filesystem.mkdir(root, { mode: ROOT_MODE });
  } catch (error: unknown) {
    // Another process created the root between the check above and this call. Whatever it
    // left behind is now an existing root like any other, so it gets validated rather than
    // trusted -- and the retry happens exactly once, since validation never creates.
    if (isExistingPathError(error)) {
      return false;
    }

    throw error;
  }

  // `mkdir`'s mode is masked by the process umask, so the bits it asked for are not
  // necessarily the bits it got. Setting them explicitly is what keeps a daemon started
  // under a permissive umask from failing its own permission check on the next start.
  await filesystem.chmod(root, ROOT_MODE);
  await filesystem.writeFileAtomic(markerPath(root), serializeMarker(context));
  return true;
}

async function validateExistingRoot(context: RootContext): Promise<void> {
  const { filesystem, root, uid } = context;
  // Only the root itself is read without following links. An *ancestor* symlink is
  // ordinary -- `/tmp` is a link to `/private/tmp` on macOS, and every test home created
  // with `mkdtemp` sits under it -- so comparing `realpath(root)` against `root` would
  // fail closed on perfectly healthy machines. Do not "harden" this into a realpath check.
  const details = await pathDetails(filesystem, root);

  if (details === undefined) {
    // The root existed a moment ago (that is why creation stood down) and is gone now.
    // Creating it here would be the second attempt this function promises never to make.
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

  await validateMarker(context);
}

async function validateMarker(context: RootContext): Promise<void> {
  const { filesystem, instanceId, root } = context;
  const path = markerPath(root);
  const details = await pathDetails(filesystem, path);

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
  const entries = await context.filesystem.readdir(context.root);

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
  let contents: string;
  try {
    contents = await context.filesystem.readFile(path);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const marker = parsed as Record<string, unknown>;
  const instanceId = marker["instanceId"];

  if (
    marker["schemaVersion"] !== 1 ||
    marker["owner"] !== "simlock" ||
    marker["platform"] !== context.platform ||
    typeof instanceId !== "string" ||
    instanceId === ""
  ) {
    return undefined;
  }

  return { schemaVersion: 1, owner: "simlock", instanceId, platform: context.platform };
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

/** `undefined` only for a path that is absent; every other failure is the caller's problem. */
async function pathDetails(filesystem: Filesystem, path: string): Promise<PathDetails | undefined> {
  try {
    return await filesystem.lstat(path);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

function rejected(
  context: RootContext,
  reason: RootRejectionReason,
  explanation: string,
): OwnedRootError {
  return new OwnedRootError(
    `Refusing the ${context.platform} device root ${context.root}: ${explanation}`,
    reason,
    context.root,
    context.platform,
  );
}

function formatMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, "0")}`;
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
