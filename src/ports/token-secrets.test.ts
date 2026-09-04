import { describe, expect, it } from "vitest";

import { CryptoTokenSecrets } from "./index.js";

describe("CryptoTokenSecrets", () => {
  it("generates secrets prefixed slk_ that differ across calls", () => {
    const secrets = new CryptoTokenSecrets();

    const first = secrets.generateSecret();
    const second = secrets.generateSecret();

    expect(first).toMatch(/^slk_/);
    expect(second).toMatch(/^slk_/);
    expect(first).not.toBe(second);
  });

  it("generates secrets carrying at least 32 bytes of entropy", () => {
    const secrets = new CryptoTokenSecrets();

    const secret = secrets.generateSecret().slice("slk_".length);

    // base64url-encodes 32 raw bytes without padding: ceil(32 * 8 / 6) = 43 chars.
    expect(secret.length).toBeGreaterThanOrEqual(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes deterministically to hex", () => {
    const secrets = new CryptoTokenSecrets();

    const first = secrets.hash("slk_some-secret");
    const second = secrets.hash("slk_some-secret");

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes different secrets to different digests", () => {
    const secrets = new CryptoTokenSecrets();

    expect(secrets.hash("slk_one")).not.toBe(secrets.hash("slk_two"));
  });
});
