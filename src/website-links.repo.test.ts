import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = join(REPO_ROOT, "website/src/content/docs/docs");
const SITE_DOCS = "https://incubator.callstack.com/simlock/docs/";

/** why: every tracked path comes from the git index, so no file escapes by sitting in a directory the test did not name. */
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .split("\0")
  .filter((name) => name.length > 0 && !name.endsWith("pnpm-lock.yaml"))
  .filter((name) => {
    try {
      return statSync(join(REPO_ROOT, name)).isFile();
    } catch {
      return false;
    }
  });

// why: a URL ends at whitespace, a quote, a backtick, a bracket or Markdown's `**`; a sentence's
// full stop is not part of it.
const DOCS_URL = /https:\/\/incubator\.callstack\.com\/simlock\/docs\/[a-z][^\s"'`)<>*\]]*/g;

const links = trackedFiles.flatMap((name) =>
  [...readFileSync(join(REPO_ROOT, name), "utf8").matchAll(DOCS_URL)].map((m) => ({
    name,
    url: m[0].replace(/[.,;:]+$/, ""),
  })),
);

const pageFile = (path: string) =>
  [join(PAGES, `${path}.mdx`), join(PAGES, path, "index.mdx")].find((file) => existsSync(file));

// why: the heading ids Starlight gives a page (github-slugger): lower case, punctuation dropped, spaces as hyphens.
const headingIds = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => /^#{2,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#+ /, "")
        .replace(/`/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/ /g, "-"),
    );

/**
 * why: the CLI, the console and the docs point users at website pages by full URL (documentation
 * rule 3), and the site is served without trailing slashes, so `page/` is a 404. A page renamed or
 * moved while the docs change fails here instead of in a user's terminal.
 */
describe("website docs URLs in the repository", () => {
  it("are found in the code and the docs", () => {
    // why: without this, a changed domain would leave the scan below with nothing to check.
    expect(links.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        "README.md",
        "src/instructions/index.ts",
        "ui/src/screens/fleet/index.tsx",
      ]),
    );
  });

  it("name a page that exists, without a trailing slash, and a heading on it", () => {
    const broken = links.filter(({ url }) => {
      const [path = "", hash] = url.slice(SITE_DOCS.length).split("#");
      // why: the HTTP API reference is generated from the OpenAPI document, not written as pages.
      if (path.startsWith("reference/http-api")) return false;
      const file = path.endsWith("/") ? undefined : pageFile(path);
      return !file || (hash !== undefined && !headingIds(file).includes(hash));
    });
    expect(broken).toEqual([]);
  });
});
