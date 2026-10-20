// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

import { brandCss } from "./src/site/brand.ts";
import { at, BASE, site as meta, noindexPaths } from "./src/site/content.ts";
import { TITLE_DELIMITER } from "./src/site/meta.ts";

const site = meta.url;
const origin = `${site}${BASE}`;
const repo = meta.repo;
const description = meta.description;
const siteDir = "website";

const doc = (name, label) => ({ label, slug: `docs/${name}` });

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
  integrations: [
    // why: Starlight would add the sitemap itself; listed so the pages outside Starlight are
    // included and the noindex ones are left out.
    sitemap({
      filter: (page) => !noindexPaths.includes(new URL(page).pathname.replace(/\.html$/, "")),
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
      sidebar: [
        doc("introduction", "Introduction"),
        doc("getting-started", "Getting started"),
        {
          label: "Reference",
          items: [
            doc("cli", "CLI"),
            doc("configuration", "Configuration"),
            doc("http-api", "HTTP API"),
            doc("client", "Programmatic client"),
            doc("console", "Web console"),
            doc("events", "Events"),
          ],
        },
      ],
      plugins: [starlightLlmsTxt({ projectName: meta.name, description })],
    }),
  ],
});
