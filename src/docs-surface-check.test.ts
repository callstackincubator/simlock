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
  "docs-surface-check.mjs",
);

const BASE: Record<string, string> = {
  "src/cli/tree.ts": 'export const tree = { lease: "lease" };\n',
  "src/core/config.ts": "export const defaults = { ttl: 1 };\n",
  "src/contract/errors.ts":
    "export const helper = 1;\nexport const ERROR_TABLE: Table = {\n  BAD_REQUEST: { exit: 2 },\n};\n",
  "src/mcp/server.ts":
    'server.registerTool(\n  "list_devices",\n  { title: "List devices" },\n  async () => {\n    return run();\n  },\n);\n',
  "src/mcp/contracts.ts": "export const schema = z.object({});\n",
  "src/http/route-declarations.ts":
    'const internal = 1;\nexport const healthz = declareRoute({ method: "get", path: "/v1/healthz" });\n',
  "src/client/index.ts": "export { connect } from './x.js';\n",
  "src/admin/index.ts": "export { admin } from './y.js';\n",
  "src/bus/index.ts":
    'export interface EventMap {\n  "lease.granted": { readonly id: string };\n}\nexport const bus = 1;\n',
  "website/src/content/docs/docs/reference/cli.mdx": "# CLI\n",
};

function repo(after: Record<string, string>, message = "head"): string {
  const dir = mkdtempSync(join(tmpdir(), "docs-surface-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  git("init", "-q", "-b", "base");
  write(BASE);
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

const edit = (file: string, from: string, to: string) => ({
  [file]: BASE[file]!.replace(from, to),
});

describe("docs-surface-check.mjs", () => {
  it.each([
    ["cli", edit("src/cli/tree.ts", '"lease" }', '"lease", nuke: "nuke" }')],
    ["config", edit("src/core/config.ts", "ttl: 1", "ttl: 2")],
    ["errors", edit("src/contract/errors.ts", "exit: 2", "exit: 3")],
    ["mcp", edit("src/mcp/server.ts", '"List devices"', '"List the devices"')],
    ["mcp", edit("src/mcp/contracts.ts", "z.object({})", "z.object({ id: z.string() })")],
    [
      "http",
      {
        "src/http/lease-declarations.ts":
          'export const r = declareRoute({ path: "/v1/leases" });\n',
      },
    ],
    ["client", edit("src/admin/index.ts", "admin", "admin, nuke")],
    ["events", edit("src/bus/index.ts", '"lease.granted"', '"lease.given"')],
  ])("fails a %s change with no website page changed, and passes it with one", (name, files) => {
    const bare = check(repo(files));
    const documented = check(
      repo({ ...files, "website/src/content/docs/docs/reference/cli.mdx": "# CLI\n\nMore.\n" }),
    );

    expect(bare).toEqual({
      status: 1,
      stdout: expect.stringContaining(
        `The public surface changed (${name}), but no page under website/src/content/docs/ did.`,
      ),
    });
    expect(documented).toEqual({ status: 0, stdout: "" });
  });

  it("passes changes outside the surface: comments, a tool's handler, code beside the error table and the routes, and a change waived by a trailer", () => {
    const cases = [
      edit("src/cli/tree.ts", "export", "// why: one tree\nexport"),
      edit("src/mcp/server.ts", "return run();", "return runAll();"),
      edit("src/contract/errors.ts", "helper = 1", "helper = 2"),
      edit("src/http/route-declarations.ts", "internal = 1", "internal = 2"),
      edit("src/bus/index.ts", "bus = 1", "bus = 2"),
    ].map((files) => check(repo(files)).status);
    const waived = check(
      repo(
        edit("src/core/config.ts", "ttl: 1", "ttl: 2"),
        "refactor: x\n\nDocs: none (internal rename)",
      ),
    );

    expect(cases).toEqual([0, 0, 0, 0, 0]);
    expect(waived.status).toBe(0);
  });
});
