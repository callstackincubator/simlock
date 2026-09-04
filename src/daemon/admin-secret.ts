import type { Filesystem, TokenSecrets } from "../ports/index.js";

/** Owner-only: the daemon's OS user is the one who can ever read `admin.token`. Consistent
 * with the rest of the daemon's local state (config.json, tokens.json, state.json) -- the real
 * trust boundary is "same OS user" (ADR 0003 §5's socket-identity note applies here too: file
 * permissions protect against another user on the box, not a hostile process running as this
 * one). */
const ADMIN_SECRET_FILE_MODE = 0o600;

export interface AdminSecretManagerOptions {
  readonly filesystem: Filesystem;
  readonly secrets: TokenSecrets;
  /** Path to `admin.token` under the daemon's data directory. */
  readonly path: string;
}

/**
 * The daemon's per-start admin secret (ADR 0003 §5, point 2). One instance per daemon process
 * lifetime: `generate()` mints a fresh secret and keeps only its hash in memory the moment the
 * instance is constructed -- `hello` can verify a credential against `#hash` immediately, long
 * before `persist()` (called only after the socket claim succeeds, see `DaemonServer#start`)
 * writes the plaintext secret to disk. `verify()` never touches the filesystem or reconstructs
 * the secret; it only ever compares hashes, so the plaintext exists nowhere but this instance's
 * private field and the file a caller reads to get it.
 *
 * A daemon that loses the start race never calls `persist()` at all (`DaemonServer#start`
 * awaits `ConnectionHost#start()`, which throws `DaemonAlreadyRunningError` before this class's
 * `persist()` is ever reached) -- so the file an already-running daemon wrote is never touched
 * by the loser. This class enforces nothing about that ordering itself; it is a consequence of
 * where its caller places the `persist()` call, called out here because it is easy to violate
 * by moving that call earlier.
 */
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

  /**
   * Writes the plaintext secret to `admin.token`, atomically (temp file, rename -- see
   * `Filesystem#writeFileAtomic`) and owner-only (mode set at creation, never a later
   * `chmod`). Callers must only invoke this after the socket claim has succeeded -- see the
   * class doc.
   */
  async persist(): Promise<void> {
    await this.#filesystem.writeFileAtomic(this.#path, `${this.#secret}\n`, {
      mode: ADMIN_SECRET_FILE_MODE,
    });
  }

  /** Removes `admin.token` on graceful stop. A daemon that never called `persist()` (lost the
   * start race) never calls this either -- both are gated by the same `DaemonServer#start`
   * success. */
  async remove(): Promise<void> {
    await this.#filesystem.rm(this.#path);
  }

  /** Constant-time-ish equality is not attempted here: `TokenSecrets#hash` output is a fixed
   * 64-char hex digest either way, and `String.prototype ===` on two hex strings of equal
   * length is not meaningfully more timing-leaky than the hash comparison every bearer-token
   * verifier in this codebase already does (`TokenStore#verify`, same pattern). */
  verify(candidate: string): boolean {
    return this.#secrets.hash(candidate) === this.#hash;
  }
}
