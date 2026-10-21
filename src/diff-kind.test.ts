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
  "diff-kind.mjs",
);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");

function kindOf(after: Record<string, string>, before: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diff-kind-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q", "-b", "base");
  writeFileSync(join(dir, "README.md"), "# Base\n");
  for (const [path, text] of Object.entries(before)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  for (const [path, text] of Object.entries(after)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  return execFileSync("node", [SCRIPT, "HEAD~1", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

describe("diff-kind.mjs", () => {
  it("calls a diff that only touches ADRs adr-only, and one that adds any other doc docs-only", () => {
    expect(kindOf({ "docs/internal/adr/0099-x.md": "# ADR\n" })).toBe("adr-only");
    expect(
      kindOf({ "docs/internal/adr/0099-x.md": "# ADR\n", "docs/internal/FLOW.md": "# Flow\n" }),
    ).toBe("docs-only");
    expect(
      kindOf({ "website/src/content/docs/docs/reference/cli.mdx": "---\ntitle: CLI\n---\n" }),
    ).toBe("docs-only");
  });

  it("calls a diff that only deletes or edits comments comments-only, and one that changes a #private line not", () => {
    const before = {
      "src/a.ts": "/**\n * Says what a is.\n */\nconst a = 1; // one\nclass B {\n  #c = 1;\n}\n",
      "run.sh": "#!/usr/bin/env sh\n# Says what runs.\necho a\n",
    };
    expect(
      kindOf(
        {
          "src/a.ts": "const a = 1; // one\nclass B {\n  #c = 1;\n}\n",
          "run.sh": "#!/usr/bin/env sh\necho a\n",
        },
        before,
      ),
    ).toBe("comments-only");
    expect(
      kindOf(
        {
          "src/a.ts":
            "/**\n * Says what a is.\n */\nconst a = 1; // one\nclass B {\n  #c = 2;\n}\n",
        },
        before,
      ),
    ).toBe("full");
  });

  it("calls tests plus docs tests-only, and tests plus one source line not tests-only", () => {
    expect(
      kindOf({ "src/a.test.ts": lines(300), "e2e/b.test.ts": lines(5), "docs/x.md": "x\n" }),
    ).toBe("tests-only");
    expect(kindOf({ "src/a.test.ts": lines(300), "src/a.ts": lines(1) })).toBe("full");
  });

  it("calls 1500 changed lines full and 1501 large, not counting pnpm-lock.yaml", () => {
    expect(kindOf({ "src/a.ts": lines(1500), "pnpm-lock.yaml": lines(500) })).toBe("full");
    expect(kindOf({ "src/a.ts": lines(1501) })).toBe("large");
  });
});
