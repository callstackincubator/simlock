import { describe, expect, it } from "vitest";

import { MemoryFilesystem, CryptoTokenSecrets, type Filesystem } from "../ports/index.js";
import { AdminSecretManager } from "./admin-secret.js";

/**
 * Regression coverage for review finding S1: `AdminSecretManager` (ADR 0003 §5's per-start
 * admin secret) had zero test coverage of its own -- everything that exercises the daemon's
 * credential handshake in `server.test.ts` goes through a stubbed `resolveRole`, so none of it
 * ever calls `persist()` or `verify()` for real.
 */
describe("AdminSecretManager", () => {
  function secrets(): CryptoTokenSecrets {
    return new CryptoTokenSecrets();
  }

  it("persist() writes the plaintext secret, newline-terminated, with mode 0600", async () => {
    const filesystem = new MemoryFilesystem();
    const manager = new AdminSecretManager({
      filesystem,
      path: "/admin.token",
      secrets: secrets(),
    });

    await manager.persist();

    const contents = await filesystem.readFile("/admin.token");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.trim().length).toBeGreaterThan(0);
    const stat = await filesystem.stat("/admin.token");
    expect(stat.mode).toBe(0o600);
  });

  // ADR §5: "owner-only permissions set at creation" -- not a later `chmod`. `Filesystem` (see
  // `ports/filesystem.ts`) has no `chmod` method at all, only `writeFileAtomic(path, contents,
  // {mode})`, so the interface itself rules out a two-step "write, then chmod" implementation --
  // this asserts `persist()` actually uses that option rather than, say, calling
  // `writeFileAtomic` without `mode` and relying on the process umask to happen to land on
  // 0600. Spying on the raw `Filesystem` call (rather than reading the mode back through
  // `MemoryFilesystem#stat`, which the test above already does) proves the *call site* passes
  // the option, not just that `MemoryFilesystem` happens to record whatever mode was implied.
  it("passes mode 0600 to writeFileAtomic itself, at the single call persist() makes", async () => {
    const calls: Array<{ readonly path: string; readonly mode: number | undefined }> = [];
    const filesystem: Filesystem = {
      readFile: () => Promise.reject(new Error("unused by this test")),
      writeFileAtomic: async (path, _contents, options) => {
        calls.push({ path, mode: options?.mode });
      },
      mkdirp: () => Promise.reject(new Error("unused by this test")),
      rm: () => Promise.reject(new Error("unused by this test")),
      stat: () => Promise.reject(new Error("unused by this test")),
      readdir: () => Promise.reject(new Error("unused by this test")),
      exists: () => Promise.reject(new Error("unused by this test")),
      diskFree: () => Promise.reject(new Error("unused by this test")),
      writeFileExclusive: () => Promise.reject(new Error("unused by this test")),
      rename: () => Promise.reject(new Error("unused by this test")),
      lstat: () => Promise.reject(new Error("unused by this test")),
      mkdir: () => Promise.reject(new Error("unused by this test")),
      chmod: () => Promise.reject(new Error("unused by this test")),
      realpath: () => Promise.reject(new Error("unused by this test")),
    };
    const manager = new AdminSecretManager({
      filesystem,
      path: "/admin.token",
      secrets: secrets(),
    });

    await manager.persist();

    expect(calls).toEqual([{ path: "/admin.token", mode: 0o600 }]);
  });

  it("remove() deletes admin.token", async () => {
    const filesystem = new MemoryFilesystem();
    const manager = new AdminSecretManager({
      filesystem,
      path: "/admin.token",
      secrets: secrets(),
    });
    await manager.persist();

    await manager.remove();

    await expect(filesystem.readFile("/admin.token")).rejects.toThrow();
  });

  it("verify() rejects a wrong candidate and accepts the real secret", async () => {
    const filesystem = new MemoryFilesystem();
    const manager = new AdminSecretManager({
      filesystem,
      path: "/admin.token",
      secrets: secrets(),
    });
    await manager.persist();
    const realSecret = (await filesystem.readFile("/admin.token")).trim();

    expect(manager.verify(realSecret)).toBe(true);
    expect(manager.verify("definitely-not-it")).toBe(false);
    expect(manager.verify("")).toBe(false);
  });

  // ADR §5: "`verify()` never touches the filesystem or reconstructs the secret; it only ever
  // compares hashes" -- and `session.ts`'s doc on the real credential handshake depends on this:
  // "`hello` verifies against memory, so a credential can be checked before the file lands and
  // before convergence." A `Filesystem` whose every method throws proves `verify()` truly never
  // calls any of them, for a correct candidate, a wrong one, and before `persist()` has ever
  // run.
  it("verify() never touches the filesystem, even before persist() has ever run", () => {
    const throwingFilesystem: Filesystem = {
      readFile: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      writeFileAtomic: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      mkdirp: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      rm: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      stat: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      readdir: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      exists: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      diskFree: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      writeFileExclusive: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      rename: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      lstat: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      mkdir: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      chmod: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      realpath: () => {
        throw new Error("verify() must not touch the filesystem");
      },
    };
    const realSecrets = secrets();
    // Constructing `AdminSecretManager` calls `secrets.generateSecret()`/`secrets.hash(...)`
    // once (see its constructor) -- capture the plaintext it generated to verify against, the
    // only way to get a real candidate without ever calling `persist()`.
    let generated = "";
    const spySecrets: CryptoTokenSecrets = {
      ...realSecrets,
      generateSecret: () => {
        generated = realSecrets.generateSecret();
        return generated;
      },
      hash: (value) => realSecrets.hash(value),
    };
    const manager = new AdminSecretManager({
      filesystem: throwingFilesystem,
      path: "/admin.token",
      secrets: spySecrets,
    });

    // None of these touch `throwingFilesystem` -- if they did, the test would already have
    // thrown before reaching these assertions.
    expect(manager.verify(generated)).toBe(true);
    expect(manager.verify("wrong")).toBe(false);
  });

  it("does not touch the filesystem at construction time either -- only persist()/remove() do", () => {
    const throwingFilesystem: Filesystem = {
      readFile: () => {
        throw new Error("must not touch the filesystem");
      },
      writeFileAtomic: () => {
        throw new Error("must not touch the filesystem");
      },
      mkdirp: () => {
        throw new Error("must not touch the filesystem");
      },
      rm: () => {
        throw new Error("must not touch the filesystem");
      },
      stat: () => {
        throw new Error("must not touch the filesystem");
      },
      readdir: () => {
        throw new Error("must not touch the filesystem");
      },
      exists: () => {
        throw new Error("must not touch the filesystem");
      },
      diskFree: () => {
        throw new Error("must not touch the filesystem");
      },
      writeFileExclusive: () => {
        throw new Error("must not touch the filesystem");
      },
      rename: () => {
        throw new Error("must not touch the filesystem");
      },
      lstat: () => {
        throw new Error("must not touch the filesystem");
      },
      mkdir: () => {
        throw new Error("must not touch the filesystem");
      },
      chmod: () => {
        throw new Error("must not touch the filesystem");
      },
      realpath: () => {
        throw new Error("must not touch the filesystem");
      },
    };

    // Constructing an `AdminSecretManager` -- e.g. a daemon that loses the start race and never
    // calls `persist()` at all (ADR §5, `admin-secret.ts`'s class doc) -- must not touch the
    // real file. Nothing here throws.
    expect(
      () =>
        new AdminSecretManager({
          filesystem: throwingFilesystem,
          path: "/admin.token",
          secrets: secrets(),
        }),
    ).not.toThrow();
  });
});
