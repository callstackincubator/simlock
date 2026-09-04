import { mkdir, readdir, rename, rm, stat, statfs, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface FileStat {
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAtMs: number;
  /** POSIX permission bits (e.g. `0o600`), masked to the low 9 bits. Not populated by every
   * caller's needs -- only relevant for callers verifying a file's permissions after creation
   * (e.g. the daemon's per-start admin secret, ADR 0003 §5). */
  readonly mode?: number;
}

export interface WriteFileAtomicOptions {
  /** POSIX permission bits the file is created with (e.g. `0o600` for owner-only). Set at
   * creation via the temp file's own open flags -- never a separate `chmod` after the fact,
   * which would leave a window where the file exists world-readable. Omitted keeps Node's
   * default (governed by the process umask), unchanged from before this option existed. */
  readonly mode?: number;
}

export interface Filesystem {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string, options?: WriteFileAtomicOptions): Promise<void>;
  mkdirp(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  diskFree(path: string): Promise<number>;
}

export class NodeFilesystem implements Filesystem {
  async readFile(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async writeFileAtomic(
    path: string,
    contents: string,
    options?: WriteFileAtomicOptions,
  ): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = join(
      directory,
      `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        flag: "wx",
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
      });
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

  // fallow-ignore-next-line unused-class-member -- reached structurally through the `Filesystem` interface (registry.ts, doctor.ts, ...), never called on a `NodeFilesystem`-typed value directly.
  async stat(path: string): Promise<FileStat> {
    const details = await stat(path);

    return {
      kind: details.isDirectory() ? "directory" : "file",
      size: details.size,
      modifiedAtMs: details.mtimeMs,
      mode: details.mode & 0o777,
    };
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

type MemoryEntry =
  | { readonly kind: "file"; contents: string; modifiedAtMs: number; mode: number }
  | { readonly kind: "directory"; modifiedAtMs: number };

const DEFAULT_FILE_MODE = 0o644;

export class MemoryFilesystem implements Filesystem {
  readonly #entries = new Map<string, MemoryEntry>([["/", { kind: "directory", modifiedAtMs: 0 }]]);

  constructor(private readonly freeDiskBytes = Number.MAX_SAFE_INTEGER) {}

  async readFile(path: string): Promise<string> {
    const entry = this.#entryAt(path);

    if (entry.kind !== "file") {
      throw new Error(`Cannot read directory: ${path}`);
    }

    return entry.contents;
  }

  async writeFileAtomic(
    path: string,
    contents: string,
    options?: WriteFileAtomicOptions,
  ): Promise<void> {
    this.#requireDirectory(parentPath(path));
    this.#entries.set(path, {
      kind: "file",
      contents,
      modifiedAtMs: 0,
      mode: options?.mode ?? DEFAULT_FILE_MODE,
    });
  }

  async mkdirp(path: string): Promise<void> {
    let currentPath = "";

    for (const segment of path.split("/")) {
      if (segment === "") {
        currentPath = "/";
        continue;
      }

      currentPath = currentPath === "/" ? `/${segment}` : `${currentPath}/${segment}`;
      const entry = this.#entries.get(currentPath);

      if (entry === undefined) {
        this.#entries.set(currentPath, { kind: "directory", modifiedAtMs: 0 });
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

  async stat(path: string): Promise<FileStat> {
    const entry = this.#entryAt(path);

    return {
      kind: entry.kind,
      size: entry.kind === "file" ? Buffer.byteLength(entry.contents) : 0,
      modifiedAtMs: entry.modifiedAtMs,
      mode: entry.kind === "file" ? entry.mode : 0o755,
    };
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

  #entryAt(path: string): MemoryEntry {
    const entry = this.#entries.get(path);
    if (entry === undefined) {
      // Carries `code: "ENOENT"` like Node's real fs errors, so callers that branch on
      // `isMissingPathError` (rather than swallowing every read failure) behave the same
      // against this fake as they do against `NodeFilesystem`.
      throw enoent(path);
    }

    return entry;
  }

  #requireDirectory(path: string): void {
    const entry = this.#entryAt(path);
    if (entry.kind !== "directory") {
      throw new Error(`Not a directory: ${path}`);
    }
  }
}

function parentPath(path: string): string {
  const lastSeparator = path.lastIndexOf("/");
  return lastSeparator <= 0 ? "/" : path.slice(0, lastSeparator);
}

export function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function enoent(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}
