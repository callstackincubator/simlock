// why: focus goes back to the row that opened the drawer, or to the page's heading when that row is
// gone or the drawer was loaded directly. A row's link is found by its path alone, trailing slash
// and query set aside, so `evt_1` does not match `evt_10`.
export function focusAfterClosing(options: {
  readonly fromList: boolean;
  readonly path: string;
  readonly links: string;
}): HTMLElement | null {
  const { fromList, links, path } = options;
  const row = fromList
    ? [...document.querySelectorAll<HTMLElement>(links)].find(
        (link) => link.getAttribute("href")?.split("?", 1)[0]?.replace(/\/$/, "") === path,
      )
    : undefined;
  return row ?? document.querySelector<HTMLElement>("main h1");
}
