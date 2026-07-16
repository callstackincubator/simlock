import { mkdir, readdir, rename, rm, stat, statfs, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface FileStat {
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface Filesystem {
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string): Promise<void>;
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
  | { readonly kind: "file"; contents: string; modifiedAtMs: number }
  | { readonly kind: "directory"; modifiedAtMs: number };

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

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.#requireDirectory(parentPath(path));
    this.#entries.set(path, { kind: "file", contents, modifiedAtMs: 0 });
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
      throw new Error(`No such file or directory: ${path}`);
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

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
