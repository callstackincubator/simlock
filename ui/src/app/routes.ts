import type { ComponentType } from "react";

import type { IconName } from "../ds";
import { AttentionScreen } from "../screens/attention";
import { EventsScreen } from "../screens/events";
import { LeasesScreen } from "../screens/leases";
import { OverviewScreen } from "../screens/overview";
import { WaitingScreen } from "../screens/waiting";
import { WorkersScreen } from "../screens/workers";

export interface Route {
  readonly path: `/${string}`;
  readonly label: string;
  readonly icon: IconName;
  readonly Screen: ComponentType;
}

export const ROUTES: readonly Route[] = [
  { Screen: OverviewScreen, icon: "overview", label: "Overview", path: "/" },
  { Screen: WorkersScreen, icon: "workers", label: "Workers", path: "/workers" },
  { Screen: LeasesScreen, icon: "leases", label: "Leases", path: "/leases" },
  { Screen: WaitingScreen, icon: "waiting", label: "Waiting", path: "/waiting" },
  { Screen: AttentionScreen, icon: "attention", label: "Attention", path: "/attention" },
  { Screen: EventsScreen, icon: "events", label: "Events", path: "/events" },
];

// why: a section's own pages live under its path (`/workers/<id>`), so a path belongs to the route
// it starts with; only the overview is matched exactly, since every path starts with `/`.
export function routeFor(path: string): Route | undefined {
  return ROUTES.find((route) =>
    route.path === "/" ? path === "/" : path === route.path || path.startsWith(`${route.path}/`),
  );
}
