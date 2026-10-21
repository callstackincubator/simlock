import { describe, expect, it } from "vitest";

import { MemoryFilesystem, CryptoTokenSecrets, type Filesystem } from "../ports/index.js";
import { AdminSecretManager } from "./admin-secret.js";

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

  // why: a Filesystem whose every method throws proves verify() never calls one, before persist() has run.
  it("verify() never touches the filesystem, even before persist() has ever run", () => {
    const throwingFilesystem: Filesystem = {
      readFile: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      readFileFrom: () => {
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
      diskSpace: () => {
        throw new Error("verify() must not touch the filesystem");
      },
      directorySize: () => {
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
    // why: the constructor generates the secret, so capturing it is the only way to get a real candidate without persist().
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

    expect(manager.verify(generated)).toBe(true);
    expect(manager.verify("wrong")).toBe(false);
  });

  it("does not touch the filesystem at construction time either -- only persist()/remove() do", () => {
    const throwingFilesystem: Filesystem = {
      readFile: () => {
        throw new Error("must not touch the filesystem");
      },
      readFileFrom: () => {
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
      diskSpace: () => {
        throw new Error("must not touch the filesystem");
      },
      directorySize: () => {
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

    // why: a daemon that loses the start race constructs the manager and never persists, so construction must not touch the real file.
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
