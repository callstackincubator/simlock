// why: the docs have one source, the repo's docs/*.md (never docs/internal), so they are copied
// into Starlight's content folder before every dev and build run instead of kept here.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoDocs = join(here, "..", "..", "docs");
const out = join(here, "..", "src", "content", "docs", "docs", "ref");
const repo = "https://github.com/callstackincubator/simlock";
const base = "/simlock";

export const pages = [
  ["ABOUT.md", "introduction", "Introduction"],
  ["CLI.md", "cli", "CLI reference"],
  ["CONFIGURATION.md", "configuration", "Configuration"],
  ["HTTP-API.md", "http-api", "HTTP API"],
  ["CLIENT.md", "client", "Programmatic client"],
  ["CONSOLE.md", "console", "Web console"],
  ["EVENTS.md", "events", "Events"],
];
const slugOf = new Map(pages.map(([file, slug]) => [file, slug]));

function rewriteLinks(md) {
  return md.replace(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g, (whole, target) => {
    const [path, hash] = target.split("#");
    const anchor = hash ? `#${hash}` : "";
    if (slugOf.has(path)) return `](${base}/docs/${slugOf.get(path)}${anchor})`;
    if (path === "../README.md") return `](${repo}#readme)`;
    const resolved = join("docs", path).replace(/\\/g, "/");
    return `](${repo}/blob/main/${resolved}${anchor})`;
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [file, slug, title] of pages) {
  const source = readFileSync(join(repoDocs, file), "utf8");
  const body = rewriteLinks(source.replace(/^# .*\n+/, ""));
  const front = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `slug: docs/${slug}`,
    `editUrl: ${repo}/edit/main/docs/${file}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(join(out, `${slug}.md`), front + body);
}
console.log(`sync-docs: ${pages.length} pages from docs/ into src/content/docs/docs/ref/`);
