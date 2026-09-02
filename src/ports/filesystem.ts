import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface FileStat {
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAtMs: number;
}

/**
 * What an un-followed `lstat` reports, narrowed to what ownership validation asks of a
 * path: what it really is, who owns it, and how exposed it is. Anything richer would be
 * a `fs.Stats` leak into the ports layer.
 */
export interface PathDetails {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly uid: number;
  /** Permission bits only (`mode & 0o777`). */
  readonly mode: number;
}

export interface Filesystem {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  /** Metadata read without following a final symlink, so a symlinked root is detectable. */
  lstat(path: string): Promise<PathDetails>;
  /**
   * Creates exactly one directory and fails when the path already exists (no recursion).
   * Failing on an existing path is the point: it is what makes "Simlock created this root
   * itself, empty" provable rather than assumed.
   */
  mkdir(path: string, options?: { readonly mode?: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Fully resolved real path. Used for diagnostics, never for rejection. */
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  diskFree(path: string): Promise<number>;
}

export class NodeFilesystem implements Filesystem {
  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error: unknown) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async rm(path: string): Promise<void> {
    await rm(path, { force: true, recursive: true });
  }

  async stat(path: string): Promise<FileStat> {
    const details = await stat(path);

    return {
      kind: details.isDirectory() ? "directory" : "file",
      size: details.size,
      modifiedAtMs: details.mtimeMs,
    };
  }

  async lstat(path: string): Promise<PathDetails> {
    const details = await lstat(path);

    return {
      kind: nodeKind(details),
      uid: details.uid,
      mode: details.mode & 0o777,
    };
  }

  async mkdir(path: string, options: { readonly mode?: number } = {}): Promise<void> {
    await mkdir(path, {
      recursive: false,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    await chmod(path, mode);
  }

  async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  async readdir(path: string): Promise<string[]> {
    return readdir(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return false;
      }

      throw error;
    }
  }

  async diskFree(path: string): Promise<number> {
    const details = await statfs(path);
    return details.bavail * details.bsize;
  }
}

/** Attributes every in-memory entry carries, so callers can read them without a `kind` check. */
interface MemoryAttributes {
  modifiedAtMs: number;
  uid: number;
  mode: number;
}

type MemoryEntryKind =
  | { readonly kind: "file"; contents: string }
  | { readonly kind: "directory" }
  | { readonly kind: "symlink"; readonly target: string };

type MemoryEntry = MemoryAttributes & MemoryEntryKind;

/**
 * Owner-only, matching the permissions Simlock demands of a device root, so a test that
 * says nothing about permissions describes a healthy path rather than a rejected one.
 */
const DEFAULT_MEMORY_MODE = 0o700;

// A symlink cycle is a legitimate thing to model; resolving it forever is not.
const MAX_SYMLINK_HOPS = 32;

export class MemoryFilesystem implements Filesystem {
  readonly #entries = new Map<string, MemoryEntry>();

  constructor(
    private readonly freeDiskBytes = Number.MAX_SAFE_INTEGER,
    private readonly uid = process.getuid?.() ?? 0,
  ) {
    this.#entries.set("/", this.#newEntry({ kind: "directory" }));
  }

  async readFile(path: string): Promise<string> {
    const entry = this.#entryAt(path);

    if (entry.kind !== "file") {
      throw new Error(`Cannot read directory: ${path}`);
    }

    return entry.contents;
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.#requireDirectory(parentPath(path));
    this.#entries.set(path, this.#newEntry({ kind: "file", contents }));
  }

  async mkdirp(path: string): Promise<void> {
    let currentPath = "";

    for (const segment of path.split("/")) {
      if (segment === "") {
        currentPath = "/";
        continue;
      }

      currentPath = joinMemoryPath(currentPath, segment);
      const entry = this.#entries.get(currentPath);

      if (entry === undefined) {
        this.#entries.set(currentPath, this.#newEntry({ kind: "directory" }));
      } else if (entry.kind !== "directory") {
        throw new Error(`Cannot create directory over file: ${currentPath}`);
      }
    }
  }

  async rm(path: string): Promise<void> {
    const prefix = path.endsWith("/") ? path : `${path}/`;

    for (const entryPath of this.#entries.keys()) {
      if (entryPath === path || entryPath.startsWith(prefix)) {
        this.#entries.delete(entryPath);
      }
    }
  }

  // fallow-ignore-next-line unused-class-member -- Filesystem.stat contract; only tests reach this implementation of it.
  async stat(path: string): Promise<FileStat> {
    const entry = this.#entryAt(path);

    return {
      kind: entry.kind === "file" ? "file" : "directory",
      size: entry.kind === "file" ? Buffer.byteLength(entry.contents) : 0,
      modifiedAtMs: entry.modifiedAtMs,
    };
  }

  async lstat(path: string): Promise<PathDetails> {
    const entry = this.#rawEntryAt(path);

    return { kind: entry.kind, uid: entry.uid, mode: entry.mode };
  }

  async mkdir(path: string, options: { readonly mode?: number } = {}): Promise<void> {
    if (this.#entries.has(path)) {
      throw errnoError("EEXIST", `File already exists: ${path}`);
    }

    this.#requireDirectory(parentPath(path));
    const entry = this.#newEntry({ kind: "directory" });
    entry.mode = (options.mode ?? DEFAULT_MEMORY_MODE) & 0o777;
    this.#entries.set(path, entry);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.#rawEntryAt(path).mode = mode & 0o777;
  }

  // fallow-ignore-next-line unused-class-member -- Filesystem.realpath contract; only tests reach this implementation of it.
  async realpath(path: string): Promise<string> {
    const resolved = this.#resolveLinks(path, 0);

    if (!this.#entries.has(resolved)) {
      throw errnoError("ENOENT", `No such file or directory: ${path}`);
    }

    return resolved;
  }

  async readdir(path: string): Promise<string[]> {
    this.#requireDirectory(path);
    const prefix = path === "/" ? "/" : `${path}/`;
    const children = new Set<string>();

    for (const entryPath of this.#entries.keys()) {
      if (!entryPath.startsWith(prefix) || entryPath === path) {
        continue;
      }

      const descendant = entryPath.slice(prefix.length);
      const child = descendant.split("/")[0];
      if (child !== undefined && child !== "") {
        children.add(child);
      }
    }

    return [...children].sort();
  }

  async exists(path: string): Promise<boolean> {
    return this.#entries.has(path);
  }

  async diskFree(_path: string): Promise<number> {
    return this.freeDiskBytes;
  }

  /** Test-only: places a symlink at `path`, whether or not `target` exists. */
  // fallow-ignore-next-line unused-class-member -- test-only state the port itself cannot create.
  defineSymlink(path: string, target: string): void {
    this.#entries.set(path, this.#newEntry({ kind: "symlink", target }));
  }

  /** Test-only: rewrites an existing entry's ownership or permission bits. */
  // fallow-ignore-next-line unused-class-member -- test-only state the port itself cannot create.
  defineAttributes(
    path: string,
    attributes: { readonly uid?: number; readonly mode?: number },
  ): void {
    const entry = this.#rawEntryAt(path);

    if (attributes.uid !== undefined) {
      entry.uid = attributes.uid;
    }

    if (attributes.mode !== undefined) {
      entry.mode = attributes.mode & 0o777;
    }
  }

  #newEntry(kind: MemoryEntryKind): MemoryEntry {
    return { ...kind, modifiedAtMs: 0, mode: DEFAULT_MEMORY_MODE, uid: this.uid };
  }

  /** The entry a following call (`stat`, `readFile`) sees: symlinks resolved. */
  #entryAt(path: string): MemoryEntry {
    return this.#rawEntryAt(this.#resolveLinks(path, 0));
  }

  /** The entry itself, symlink or not, as `lstat` and `chmod` address it. */
  #rawEntryAt(path: string): MemoryEntry {
    const entry = this.#entries.get(path);
    if (entry === undefined) {
      throw errnoError("ENOENT", `No such file or directory: ${path}`);
    }

    return entry;
  }

  /**
   * Resolves symlinks in every component, not just the last one, because that is what
   * makes the "an ancestor symlink is normal, and not grounds for rejection" case
   * expressible in a test at all.
   */
  #resolveLinks(path: string, hops: number): string {
    if (path === "/") {
      return "/";
    }

    if (hops > MAX_SYMLINK_HOPS) {
      throw errnoError("ELOOP", `Too many levels of symbolic links: ${path}`);
    }

    const resolved = joinMemoryPath(
      this.#resolveLinks(parentPath(path), hops),
      path.slice(path.lastIndexOf("/") + 1),
    );
    const entry = this.#entries.get(resolved);

    return entry?.kind === "symlink" ? this.#resolveLinks(entry.target, hops + 1) : resolved;
  }

  #requireDirectory(path: string): void {
    const entry = this.#entryAt(path);
    if (entry.kind !== "directory") {
      throw errnoError("ENOTDIR", `Not a directory: ${path}`);
    }
  }
}

function joinMemoryPath(parent: string, child: string): string {
  return parent === "/" || parent === "" ? `/${child}` : `${parent}/${child}`;
}

function parentPath(path: string): string {
  const lastSeparator = path.lastIndexOf("/");
  return lastSeparator <= 0 ? "/" : path.slice(0, lastSeparator);
}

function nodeKind(details: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): PathDetails["kind"] {
  if (details.isSymbolicLink()) return "symlink";
  if (details.isDirectory()) return "directory";
  return details.isFile() ? "file" : "other";
}

/**
 * Callers branch on `code` -- an existing root is only "somebody won the race" when the
 * failure is `EEXIST`, and a path is only absent when the failure is `ENOENT` -- so the
 * in-memory double has to speak Node's errno vocabulary, not just fail.
 */
function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
