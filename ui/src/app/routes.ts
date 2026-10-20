import type { ComponentType } from "react";

import type { IconName } from "../ds";
import { InboxScreen } from "../screens/inbox";
import { ActivityScreen } from "../screens/activity";
import { LeasesScreen } from "../screens/leases";
import { OverviewScreen } from "../screens/overview";
import { UsageScreen } from "../screens/usage";
import { QueueScreen } from "../screens/queue";
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
  { Screen: InboxScreen, icon: "inbox", label: "Inbox", path: "/inbox" },
  { Screen: FleetScreen, group: "Operate", icon: "workers", label: "Fleet", path: "/fleet" },
  { Screen: LeasesScreen, group: "Operate", icon: "leases", label: "Leases", path: "/leases" },
  { Screen: QueueScreen, group: "Operate", icon: "waiting", label: "Queue", path: "/queue" },
  {
    Screen: ActivityScreen,
    group: "Observe",
    icon: "events",
    label: "Activity",
    path: "/activity",
  },
  { Screen: UsageScreen, group: "Observe", icon: "usage", label: "Usage", path: "/usage" },
];

// why: a section's own pages live under its path (`/fleet/<id>`), so a path belongs to the route
// it starts with; only the overview is matched exactly, since every path starts with `/`.
export function routeFor(path: string): Route | undefined {
  return ROUTES.find((route) =>
    route.path === "/" ? path === "/" : path === route.path || path.startsWith(`${route.path}/`),
  );
}
