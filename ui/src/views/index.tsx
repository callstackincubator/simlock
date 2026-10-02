import type { ComponentType } from "react";

import { ComingSoon } from "./coming-soon";

/**
 * Every view the console has, in navigation order. An entry is one nav link and one page: its
 * `path` is the page's URL, `label` names it in the nav and the page title, and `Component`
 * renders the page inside the shell. Adding a view is adding an entry here.
 */
export interface View {
  readonly path: `/${string}`;
  readonly label: string;
  readonly Component: ComponentType;
}

export const VIEWS: readonly View[] = [
  { path: "/workers", label: "Workers", Component: () => <ComingSoon title="Workers" /> },
  { path: "/leases", label: "Leases", Component: () => <ComingSoon title="Leases" /> },
  { path: "/waiting", label: "Waiting", Component: () => <ComingSoon title="Waiting" /> },
  { path: "/attention", label: "Attention", Component: () => <ComingSoon title="Attention" /> },
  { path: "/events", label: "Events", Component: () => <ComingSoon title="Events" /> },
];

/** The view a path shows, or `undefined` for a path the console has no view for. */
export function viewFor(path: string): View | undefined {
  return VIEWS.find((view) => path === view.path || path.startsWith(`${view.path}/`));
}
