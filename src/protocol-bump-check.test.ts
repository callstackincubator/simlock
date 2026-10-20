import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "protocol-bump-check.mjs",
);

const PROTOCOL = (n: number) =>
  `export const PROTOCOL_VERSION_RANGE: ProtocolRange = { min: ${n}, max: ${n} };\n`;
const SCHEMAS = "export const lease = z.object({ id: z.string() });\n";

function repo(after: Record<string, string>, message = "head"): string {
  const dir = mkdtempSync(join(tmpdir(), "protocol-bump-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git("init", "-q", "-b", "base");
  write({
    "src/contract/protocol.ts": PROTOCOL(7),
    "src/contract/schemas.ts": SCHEMAS,
    "src/contract/duration.ts": "export const second = 1000;\n",
  });
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  write(after);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
  return dir;
}

function check(dir: string) {
  try {
    execFileSync("node", [SCRIPT, "--base", "base"], { cwd: dir, encoding: "utf8" });
    return { status: 0, stdout: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: string };
    return { status: failed.status, stdout: failed.stdout };
  }
}

const SHAPE_CHANGE = {
  "src/contract/schemas.ts":
    "export const lease = z.object({ id: z.string(), ttl: z.number() });\n",
};

describe("protocol-bump-check.mjs", () => {
  it("fails a contract shape change that leaves the protocol range as it was, and passes it with the range bumped", () => {
    const unbumped = check(repo(SHAPE_CHANGE));
    const bumped = check(repo({ ...SHAPE_CHANGE, "src/contract/protocol.ts": PROTOCOL(8) }));

    expect(unbumped).toEqual({
      status: 1,
      stdout: expect.stringContaining(
        "src/contract/schemas.ts: contract shape changed, but PROTOCOL_VERSION_RANGE stays 7..7.",
      ),
    });
    expect(bumped).toEqual({ status: 0, stdout: "" });
  });

  it("fails a protocol bump with no contract shape change", () => {
    const result = check(repo({ "src/contract/protocol.ts": PROTOCOL(8) }));

    expect(result).toEqual({
      status: 1,
      stdout: expect.stringContaining(
        "PROTOCOL_VERSION_RANGE moves 7..7 to 8..8 with no contract shape change.",
      ),
    });
  });

  it("passes edits that change no wire shape: comments, helpers, tests, and a change waived by a commit trailer", () => {
    const cases = [
      { "src/contract/schemas.ts": `// why: ids are opaque\n${SCHEMAS}` },
      { "src/contract/duration.ts": "export const second = 1_000;\n" },
      { "src/contract/schemas.test.ts": "it('x', () => {});\n" },
    ].map((files) => check(repo(files)).status);
    const waived = check(repo(SHAPE_CHANGE, "refactor: x\n\nProtocol-bump: none (rename only)"));

    expect(cases).toEqual([0, 0, 0]);
    expect(waived.status).toBe(0);
  });
});
