import type { Filesystem, TokenSecrets } from "../ports/index.js";

// why: the real trust boundary is the same OS user, so owner-only (0600) protects against another user, not a hostile process running as this one.
const ADMIN_SECRET_FILE_MODE = 0o600;

export interface AdminSecretManagerOptions {
  readonly filesystem: Filesystem;
  readonly secrets: TokenSecrets;

  readonly path: string;
}

export class AdminSecretManager {
  readonly #filesystem: Filesystem;
  readonly #secrets: TokenSecrets;
  readonly #path: string;
  readonly #secret: string;
  readonly #hash: string;

  constructor(options: AdminSecretManagerOptions) {
    this.#filesystem = options.filesystem;
    this.#secrets = options.secrets;
    this.#path = options.path;
    this.#secret = options.secrets.generateSecret();
    this.#hash = this.#secrets.hash(this.#secret);
  }

  // why: call this only after the socket claim has succeeded, so a daemon that loses the start race never touches the winner's file.
  async persist(): Promise<void> {
    await this.#filesystem.writeFileAtomic(this.#path, `${this.#secret}\n`, {
      mode: ADMIN_SECRET_FILE_MODE,
    });
  }

  async remove(): Promise<void> {
    await this.#filesystem.rm(this.#path);
  }

  // why: both sides are fixed-length hex digests, so a plain `===` is no more timing-leaky than the hash comparison in `TokenStore#verify`.
  verify(candidate: string): boolean {
    return this.#secrets.hash(candidate) === this.#hash;
  }
}
