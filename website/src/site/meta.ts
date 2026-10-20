// why: every page's <title>, og:title and twitter:title, docs included, come from this one
// pattern, so they always agree.
import { site } from "./content.ts";

export const TITLE_DELIMITER = "|";

export function fullTitle(pageTitle?: string): string {
  return pageTitle
    ? `${pageTitle} ${TITLE_DELIMITER} ${site.name}`
    : `${site.name}: ${site.subtitle}`;
}
