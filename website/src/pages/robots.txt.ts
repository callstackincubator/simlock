// why: built from the site origin in content.ts, so it never points at another domain.
import type { APIRoute } from "astro";

import { at, site } from "../site/content";

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${site.url}${at("/sitemap-index.xml")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
