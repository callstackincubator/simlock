import type { ComponentType } from "react";

import type { IconName } from "../ds";
import { AttentionScreen } from "../screens/attention";
import { EventsScreen } from "../screens/events";
import { LeasesScreen } from "../screens/leases";
import { OverviewScreen } from "../screens/overview";
import { UsageScreen } from "../screens/usage";
import { WaitingScreen } from "../screens/waiting";
import { FleetScreen } from "../screens/fleet";

export type NavGroup = "Operate" | "Observe";

export interface Route {
  readonly path: `/${string}`;
  readonly label: string;
  readonly icon: IconName;
  readonly group?: NavGroup;
  readonly Screen: ComponentType;
}

export const ROUTES: readonly Route[] = [
  { Screen: OverviewScreen, icon: "overview", label: "Overview", path: "/" },
  { Screen: AttentionScreen, icon: "attention", label: "Attention", path: "/attention" },
  { Screen: FleetScreen, group: "Operate", icon: "workers", label: "Fleet", path: "/fleet" },
  { Screen: LeasesScreen, group: "Operate", icon: "leases", label: "Leases", path: "/leases" },
  { Screen: WaitingScreen, group: "Operate", icon: "waiting", label: "Queue", path: "/queue" },
  { Screen: EventsScreen, group: "Observe", icon: "events", label: "Activity", path: "/activity" },
  { Screen: UsageScreen, group: "Observe", icon: "usage", label: "Usage", path: "/usage" },
];

// why: a section's own pages live under its path (`/fleet/<id>`), so a path belongs to the route
// it starts with; only the overview is matched exactly, since every path starts with `/`.
export function routeFor(path: string): Route | undefined {
  return ROUTES.find((route) =>
    route.path === "/" ? path === "/" : path === route.path || path.startsWith(`${route.path}/`),
  );
}
