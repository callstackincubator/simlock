// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmActions from "starlight-llm-actions";
import starlightOpenAPI, { createOpenAPISidebarGroup } from "starlight-openapi";

import { brandCss } from "./src/site/brand.ts";
import { checkLinks } from "./src/site/check-links.ts";
import { at, BASE, site as meta, noindexPaths } from "./src/site/content.ts";
import { TITLE_DELIMITER } from "./src/site/meta.ts";
import {
  docPages,
  lastModified,
  readingOrder,
  sections,
  sourcesOf,
  topLevelPages,
} from "./src/site/pages.ts";

const site = meta.url;
const origin = `${site}${BASE}`;
const repo = meta.repo;
const description = meta.description;
const siteDir = "website";

const openAPISidebarGroup = createOpenAPISidebarGroup();

// why: read once per build, so a page added, moved or renamed reaches the sidebar, llms.txt and
// the sitemap without a list to edit.
const pages = docPages();

export default defineConfig({
  site,
  // why: GitHub Pages serves the repo's site under /simlock.
  base: BASE,
  // why: pages are files (`docs/introduction.html`, `404.html`); GitHub Pages serves each at its
  // path without `.html`, and a trailing slash would point at a folder that does not exist.
  trailingSlash: "never",
  build: { format: "file" },
  // why: Markdown screenshots get a srcset, so phones don't download huge files.
  image: { layout: "constrained" },
  devToolbar: { enabled: false },
  // why: shipped CLIs and old links keep pointing at moved docs pages.
  redirects: {
    "/docs/introduction/requirements": `${BASE}/docs/introduction/pick-your-setup`,
    "/docs/getting-started": `${BASE}/docs/introduction/pick-your-setup`,
    "/docs/getting-started/next-steps": `${BASE}/docs/introduction/pick-your-setup`,
    "/docs/using-devices/choosing-a-device": `${BASE}/docs/using-devices/lease-a-specific-device`,
    "/docs/using-devices/lease-lifecycle": `${BASE}/docs/using-devices/keep-a-device`,
    "/docs/using-devices/working-with-a-device": `${BASE}/docs/using-devices/run-commands`,
    "/docs/using-devices/physical-devices": `${BASE}/docs/using-devices/lease-a-phone`,
    "/docs/using-devices/watching-the-screen": `${BASE}/docs/using-devices/watch-the-screen`,
    "/docs/using-devices/remote-agents": `${BASE}/docs/using-devices/http-api`,
    "/docs/using-devices/programmatic-client": `${BASE}/docs/using-devices/node-client`,
    "/docs/using-devices/errors": `${BASE}/docs/troubleshooting/lease-fails`,
    "/docs/worker/running-the-daemon": `${BASE}/docs/worker/daemon`,
    "/docs/worker/windows": `${BASE}/docs/getting-started/windows`,
    "/docs/worker/configuration": `${BASE}/docs/worker/change-a-setting`,
    "/docs/worker/cleanup": `${BASE}/docs/worker/free-disk`,
    "/docs/worker/enrolling-physical-devices": `${BASE}/docs/worker/enrol-phones`,
    "/docs/worker/console": `${BASE}/docs/worker/console-and-http`,
    "/docs/worker/troubleshooting": `${BASE}/docs/troubleshooting/worker`,
    "/docs/worker/baselines": `${BASE}/docs/worker/save-a-prepared-device`,
    "/docs/gateway": `${BASE}/docs/concepts/workers-and-gateways`,
    "/docs/gateway/joining-workers": `${BASE}/docs/gateway/add-a-worker`,
    "/docs/gateway/routing": `${BASE}/docs/concepts/workers-and-gateways`,
    "/docs/gateway/managing-workers": `${BASE}/docs/gateway/maintain-workers`,
    "/docs/gateway/access-control": `${BASE}/docs/gateway/access`,
    "/docs/gateway/fleet-console": `${BASE}/docs/reference/console`,
  },
  integrations: [
    // why: Starlight would add the sitemap itself; listed so the pages outside Starlight are
    // included and the noindex ones are left out.
    sitemap({
      filter: (page) => !noindexPaths.includes(new URL(page).pathname.replace(/\.html$/, "")),
      // why: the date of the last commit to the page's source, so crawlers can tell what changed.
      serialize(item) {
        // why: the integration lists the home page twice, with and without the slash; only
        // `/simlock/` is served (the other redirects to it) and named by its canonical.
        if (item.url === origin) return undefined;
        const path = new URL(item.url).pathname.slice(BASE.length);
        const lastmod = lastModified(sourcesOf(path, pages));
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    starlight({
      // why: docs titles must read "Page | Name", the pattern src/site/meta.ts builds for every page.
      title: meta.name,
      titleDelimiter: TITLE_DELIMITER,
      description,
      favicon: "/favicon.svg",
      // why: src/pages/404.astro replaces Starlight's 404, in the site's look.
      disable404Route: true,
      routeMiddleware: "./src/routeData.ts",
      customCss: ["./src/fonts/font-face.css", "./src/styles/theme.css", "./src/styles/docs.css"],
      components: {
        ThemeProvider: "./src/components/starlight/ThemeProvider.astro",
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
        SocialIcons: "./src/components/starlight/SocialIcons.astro",
        Footer: "./src/components/starlight/Footer.astro",
      },
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/${siteDir}/src/content/docs/` },
      head: [
        { tag: "style", content: brandCss },
        // why: Starlight sets og:title, og:description and a large Twitter card, but no image.
        { tag: "meta", attrs: { property: "og:image", content: `${origin}/og-image.jpg` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: meta.ogAlt } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${origin}/og-image.jpg` } },
        { tag: "meta", attrs: { name: "twitter:image:alt", content: meta.ogAlt } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0a0a0a" } },
        {
          tag: "link",
          attrs: { rel: "icon", href: at("/favicon-32.png"), type: "image/png", sizes: "32x32" },
        },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: at("/apple-touch-icon.png") } },
        {
          tag: "link",
          attrs: { rel: "alternate", type: "text/plain", title: "llms.txt", href: at("/llms.txt") },
        },
      ],
      // why: each group lists every page in its folder, in the order of the pages' frontmatter
      // `sidebar.order` (and `sidebar.label`, where it differs from the title).
      sidebar: [
        ...sections.map(({ label, directory }) => ({
          label,
          items: [
            { autogenerate: { directory } },
            ...(directory === "docs/reference" ? [openAPISidebarGroup] : []),
          ],
        })),
        ...topLevelPages(pages).map((slug) => ({ slug })),
      ],
      plugins: [
        // why: one Markdown copy of every page at its URL plus `.md`, linked from the page, and
        // llms.txt listing each of them, all rendered from the docs collection on every build.
        starlightLlmActions({
          renderMarkdown: "simple",
          linkAlternate: true,
          actions: { openIn: false },
          llmsTxt: {
            title: meta.name,
            description,
            promote: readingOrder(pages),
            subsets: sections.map(({ label, directory }) => ({
              label,
              paths: [directory, `${directory}/**`],
            })),
          },
        }),
        starlightOpenAPI([
          {
            base: "docs/reference/http-api",
            schema: "public/openapi.json",
            sidebar: { label: "HTTP API reference", group: openAPISidebarGroup },
          },
        ]),
      ],
    }),
    checkLinks({ origin: site, base: BASE }),
  ],
});
