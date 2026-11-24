const PATH_PLACEHOLDER = "{path}";

// why: the daemon hands over the operator's template as written; the page the person was on is only
// known here, so `{path}` is replaced when the link is built, and the scheme check runs on the result.
export function signInHref(template: unknown, path: string): string | undefined {
  if (typeof template !== "string") return undefined;
  const href = template.split(PATH_PLACEHOLDER).join(encodeURIComponent(path));
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:" ? href : undefined;
  } catch {
    return undefined;
  }
}
