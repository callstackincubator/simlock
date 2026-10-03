import type { ComponentType } from "react";

import { AttentionView } from "./attention";
import { EventsView } from "./events";
import { LeasesView } from "./leases";
import { WaitingView } from "./waiting";
import { WorkersView } from "./workers";

/**
 * Every view the console has, in tab order. An entry is one tab and one page: its `path` is the
 * page's URL, `label` names it on its tab and in the page title, and `Component` renders the
 * page inside the shell. A view's own pages live under its path, as one worker's page lives at
 * `/workers/<id>`. Adding a view is adding an entry here.
 */
export interface View {
  readonly path: `/${string}`;
  readonly label: string;
  readonly Component: ComponentType;
}

export const VIEWS: readonly View[] = [
  { path: "/workers", label: "Workers", Component: WorkersView },
  { path: "/leases", label: "Leases", Component: LeasesView },
  { path: "/waiting", label: "Waiting", Component: WaitingView },
  { path: "/attention", label: "Attention", Component: AttentionView },
  { path: "/events", label: "Events", Component: EventsView },
];

/**
 * The view a path shows, or `undefined` for a path the console has no view for. `/` shows the
 * first view; the shell then rewrites the address to that view's own path.
 */
export function viewFor(path: string): View | undefined {
  if (path === "/") return VIEWS[0];
  return VIEWS.find((view) => path === view.path || path.startsWith(`${view.path}/`));
}
