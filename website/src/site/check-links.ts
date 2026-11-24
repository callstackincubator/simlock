// why: pages move while the docs are rewritten, and nothing else notices a link to a page or a
// heading that no longer exists (the home page's deep links in content.ts, a canonical, a docs
// link). After the build, every link under the site's own base must reach a built file, and its
// `#hash` an `id` in that page, or the build fails.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

export function checkLinks({ origin, base }: { origin: string; base: string }): AstroIntegration {
  return {
    name: "check-links",
    hooks: {
      "astro:build:done": ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const pages = walk(root).filter((file) => file.endsWith(".html"));
        const ids = new Map<string, Set<string>>();
        const idsOf = (file: string) => {
          let found = ids.get(file);
          if (!found) {
            const html = readFileSync(file, "utf8");
            found = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
            ids.set(file, found);
          }
          return found;
        };
        // why: a page is built as `name.html` and served at `name`; a folder's page as `index.html`.
        const target = (path: string) =>
          [join(root, path), join(root, `${path}.html`), join(root, path, "index.html")].find(isFile);

        const broken: string[] = [];
        const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const link = new RegExp(
          `\\s(?:href|src)="(?:${escape(origin)})?(${escape(base)}(?:[/#?][^"]*)?)"`,
          "g",
        );
        for (const page of pages) {
          for (const [, url] of readFileSync(page, "utf8").matchAll(link)) {
            const [rest, hash] = url.slice(base.length).split("#");
            const path = decodeURIComponent(rest.split("?")[0]);
            const file = target(path);
            const ok = file && (!hash || !file.endsWith(".html") || idsOf(file).has(decodeURIComponent(hash)));
            if (!ok) broken.push(`${relative(root, page)} → ${url}`);
          }
        }
        if (broken.length > 0) {
          throw new Error(`${broken.length} broken internal links:\n${[...new Set(broken)].join("\n")}`);
        }
        logger.info(`${pages.length} pages, no broken internal links`);
      },
    },
  };
}
