export interface ForeignFolders {
  readonly deviceSet: string;
  readonly sourcesSet: string;
  /** why: absent when the daemon names no log folder; only device folders are then swapped. */
  readonly logsRoot?: string | undefined;
  readonly ownUdid: string;
}

const UDID = "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}";

function pattern(roots: readonly string[]): RegExp {
  const alternatives = roots.map((root) => root.split("/").map(escapeRegExp).join("/"));
  return new RegExp(`(?:${alternatives.join("|")})/(${UDID})`, "g");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    udid === folders.ownUdid ? match : `${root}/${folders.ownUdid}`;
  let swapped = text.replace(devices, own(folders.deviceSet));
  if (folders.logsRoot !== undefined) {
    swapped = swapped.replace(pattern([folders.logsRoot]), own(folders.logsRoot));
  }
  return Buffer.from(swapped, "latin1");
}
