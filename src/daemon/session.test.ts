import { describe, expect, it, vi } from "vitest";

import {
  AdminAuthenticationFailedError,
  createCredentialRoleResolver,
  resolveAgentRole,
  type AdminCredentialVerifier,
} from "./session.js";

/**
 * Regression coverage for review finding S1: `createCredentialRoleResolver` (ADR 0003 §5) was
 * untested -- every role/ownership test in `server.test.ts` injects a *stubbed* `resolveRole`,
 * so the real credential-checking logic (the resolver `main.ts` actually wires up against
 * `TokenStore#verify` and `AdminSecretManager#verify`) had zero coverage. These tests exercise
 * `createCredentialRoleResolver` directly against a scripted `AdminCredentialVerifier`, the
 * narrow interface it depends on -- no real token store or admin secret needed.
 */
describe("createCredentialRoleResolver", () => {
  function verifier(overrides: Partial<AdminCredentialVerifier> = {}): AdminCredentialVerifier {
    return {
      verifyOperatorToken: vi.fn().mockResolvedValue(false),
      verifyAdminSecret: vi.fn().mockReturnValue(false),
      ...overrides,
    };
  }

  it("resolves agent, unconditionally, when hello carries no credential", async () => {
    const verify = verifier({
      // Neither should even be consulted with no credential to check -- see the "never calls
      // either verifier" test below for the stronger assertion.
      verifyOperatorToken: vi.fn().mockResolvedValue(true),
      verifyAdminSecret: vi.fn().mockReturnValue(true),
    });
    const resolver = createCredentialRoleResolver(verify);

    await expect(resolver.resolve({})).resolves.toBe("agent");
    await expect(resolver.resolve({ principal: "someone" })).resolves.toBe("agent");
  });

  it("never calls either verifier when hello carries no credential", async () => {
    const verifyOperatorToken = vi.fn().mockResolvedValue(false);
    const verifyAdminSecret = vi.fn().mockReturnValue(false);
    const resolver = createCredentialRoleResolver({ verifyOperatorToken, verifyAdminSecret });

    await resolver.resolve({ principal: "someone" });

    expect(verifyOperatorToken).not.toHaveBeenCalled();
    expect(verifyAdminSecret).not.toHaveBeenCalled();
  });

  // ADR §5: "Two credentials are accepted, checked in this order: 1. An operator token ...
  // 2. The per-start admin secret." Provable order, not just provable outcome: give both
  // verifiers a way to record *when* they were called, and assert the operator check happened
  // first.
  it("checks the operator token store before the per-start admin secret", async () => {
    const calls: string[] = [];
    const resolver = createCredentialRoleResolver({
      verifyOperatorToken: async (secret) => {
        calls.push(`operator:${secret}`);
        return false;
      },
      verifyAdminSecret: (secret) => {
        calls.push(`admin-secret:${secret}`);
        return true;
      },
    });

    await expect(resolver.resolve({ credential: "slk_whatever" })).resolves.toBe("admin");

    expect(calls).toEqual(["operator:slk_whatever", "admin-secret:slk_whatever"]);
  });

  it("resolves admin when only the operator token store accepts the credential", async () => {
    const verifyAdminSecret = vi.fn().mockReturnValue(false);
    const resolver = createCredentialRoleResolver({
      verifyOperatorToken: async (secret) => secret === "slk_operator",
      verifyAdminSecret,
    });

    await expect(resolver.resolve({ credential: "slk_operator" })).resolves.toBe("admin");
    // Short-circuits: the admin-secret check never runs once the operator token store already
    // accepted the credential.
    expect(verifyAdminSecret).not.toHaveBeenCalled();
  });

  it("resolves admin when only the per-start admin secret accepts the credential", async () => {
    const resolver = createCredentialRoleResolver({
      verifyOperatorToken: async () => false,
      verifyAdminSecret: (secret) => secret === "the-admin-secret",
    });

    await expect(resolver.resolve({ credential: "the-admin-secret" })).resolves.toBe("admin");
  });

  // The specific guarantee ADR §5/`session.ts`'s doc calls out: a bearer token that verifies
  // but carries the "agent" role must never resolve to "admin" here -- `AdminCredentialVerifier`
  // is deliberately typed so `verifyOperatorToken` can only ever answer "operator or not", never
  // hand back a role, so this is really asserting the interface shape is honored by a verifier
  // that mirrors what `TokenStore#verify` actually does (a token exists but isn't `operator`).
  it("never resolves admin for a credential that verifies as a non-operator (agent-role) token", async () => {
    const resolver = createCredentialRoleResolver({
      // Mirrors `main.ts`'s real wiring: `(await tokens.verify(secret))?.role === "operator"` --
      // a token that exists in the store but whose role isn't "operator" (an agent-role bearer
      // token) answers false here, exactly like a credential with no matching token at all.
      verifyOperatorToken: async () => false,
      verifyAdminSecret: () => false,
    });

    await expect(resolver.resolve({ credential: "slk_agent_token" })).rejects.toThrow(
      AdminAuthenticationFailedError,
    );
  });

  it("throws AdminAuthenticationFailedError for a credential neither verifier accepts", async () => {
    const resolver = createCredentialRoleResolver(verifier());

    await expect(resolver.resolve({ credential: "not-a-real-secret" })).rejects.toThrow(
      AdminAuthenticationFailedError,
    );
  });

  it("never echoes the rejected credential in the thrown error's message", async () => {
    const resolver = createCredentialRoleResolver(verifier());

    await expect(resolver.resolve({ credential: "slk_super_secret_value" })).rejects.toThrow(
      AdminAuthenticationFailedError,
    );
    try {
      await resolver.resolve({ credential: "slk_super_secret_value" });
      expect.unreachable("resolve should have thrown");
    } catch (error: unknown) {
      expect(String(error)).not.toContain("slk_super_secret_value");
    }
  });
});

describe("resolveAgentRole", () => {
  it("resolves agent unconditionally, regardless of what hello sends", () => {
    expect(resolveAgentRole.resolve({})).toBe("agent");
    expect(resolveAgentRole.resolve({ credential: "anything", principal: "someone" })).toBe(
      "agent",
    );
  });
});
