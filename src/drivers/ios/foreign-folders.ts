export interface ForeignFolders {
  readonly deviceSet: string;
  readonly sourcesSet: string;
  /** why: absent when the daemon names no log folder; only device folders are then swapped. */
  readonly logsRoot?: string | undefined;
  readonly ownUdid: string;
}

const UDID = "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}";
const PRIVATE = "/private";
// why: the regular expression for one separator: a plain `/`, or a backslash and a `/`.
const SEPARATORS = ["/", "\\\\/"] as const;

/** why: iOS writes a folder under `/private` in two spellings (`/private/tmp/x` and `/tmp/x`), and each is matched and kept. */
function spellings(root: string): readonly string[] {
  return root.startsWith(`${PRIVATE}/`) ? [root, root.slice(PRIVATE.length)] : [root];
}

/** why: a path is written with plain separators or with all of them escaped, never a mix; a stray backslash before a plain `/` in binary data is not part of a path, and swapping it as one would change a length. */
function pattern(roots: readonly string[]): RegExp {
  const alternatives = roots
    .flatMap(spellings)
    .sort((a, b) => b.length - a.length)
    .flatMap((root) =>
      SEPARATORS.map(
        (separator) => `${root.split("/").map(escapeRegExp).join(separator)}${separator}`,
      ),
    );
  return new RegExp(`(?:${alternatives.join("|")})(${UDID})`, "g");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** why: the copy's own folder in the spelling and with the separators of the path it replaces. */
function ownFolder(root: string, udid: string, found: string): string {
  const escaped = found.includes("\\/");
  const plain = escaped ? found.replaceAll("\\/", "/") : found;
  const spelling =
    spellings(root).find(
      (candidate) => !plain.startsWith(PRIVATE) === !candidate.startsWith(PRIVATE),
    ) ?? root;
  return `${spelling}/${udid}`.replaceAll("/", escaped ? "\\/" : "/");
}

/** why: ADR 0076 §2: a source's index lists the files and links that name any simulator's device or log folder, its own included. */
export function namesAnyFolder(
  bytes: Uint8Array,
  folders: Omit<ForeignFolders, "ownUdid">,
): boolean {
  const text = Buffer.from(bytes).toString("latin1");
  return (
    pattern([folders.deviceSet, folders.sourcesSet]).test(text) ||
    (folders.logsRoot !== undefined && pattern([folders.logsRoot]).test(text))
  );
}

/**
 * why: ADR 0076 §3: every device or log folder of another simulator becomes the copy's own, byte for byte,
 * so a file's length never changes and the swap needs to understand no format. Bytes map one to one to
 * `latin1` characters, so a binary file passes through untouched outside the paths.
 */
export function swapForeignFolders(bytes: Uint8Array, folders: ForeignFolders): Uint8Array {
  const text = Buffer.from(bytes).toString("latin1");
  const devices = pattern([folders.deviceSet, folders.sourcesSet]);
  const own = (root: string) => (match: string, udid: string) =>
    udid === folders.ownUdid ? match : ownFolder(root, folders.ownUdid, match);
  let swapped = text.replace(devices, own(folders.deviceSet));
  if (folders.logsRoot !== undefined) {
    swapped = swapped.replace(pattern([folders.logsRoot]), own(folders.logsRoot));
  }
  return Buffer.from(swapped, "latin1");
}
